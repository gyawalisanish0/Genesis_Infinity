import { readFileSync } from "node:fs";
import {
  getLlama,
  defineChatSessionFunction,
  LlamaChatSession,
  type ChatSessionModelFunctions,
} from "node-llama-cpp";
import type { Action, ActionResult, RejectionResult, ToolContext } from "../tools/index.js";
import {
  getScopeTool,
  getCharacterSheetTool,
  getRecentDtmTool,
  sayTool,
  noteHazardTool,
  checkAction,
  applyAction,
  rejectAction,
} from "../tools/index.js";
import { RuleValidator } from "../rules/index.js";
import { NarrationAuditor } from "../audit/index.js";
import { getState } from "../state/index.js";

/**
 * Small models occasionally emit the literal string "null"/"undefined"/
 * "none" for an omitted optional field instead of leaving it out or using
 * "" — observed in real testing against Llama-3.2-3B-Instruct, where a
 * targetId of "null" caused a bogus "\"null\" not found" rejection instead
 * of being treated as absent. Normalized at the tool-call boundary so
 * tools/'s gates see an actually-absent value rather than a lookup target.
 */
const NULLISH_STRINGS = new Set(["null", "undefined", "none"]);
function normalizeOptionalId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return NULLISH_STRINGS.has(value.trim().toLowerCase()) ? undefined : value;
}

/**
 * Detects the container's actual CPU quota from cgroup limits, if any.
 * /proc/cpuinfo (and thus node-llama-cpp's own core auto-detection) reports
 * the host machine's full physical core count even inside a quota-limited
 * container — observed directly on a Hugging Face CPU Space that reports 16
 * cores but is only entitled to 2 cores' worth of CPU time. Letting
 * node-llama-cpp size its thread pool off the wrong number causes
 * oversubscription and CFS-scheduler throttling stalls rather than a real
 * speedup. Returns undefined (no override, current auto-detect behavior
 * unchanged) when there's no cgroup limit or this isn't a cgroup-managed
 * environment at all — e.g. this repo's own dev sandbox, which reports an
 * unlimited quota (-1) and should keep using all its actual cores.
 */
function detectCpuQuota(): number | undefined {
  try {
    const [quota, period] = readFileSync("/sys/fs/cgroup/cpu.max", "utf-8").trim().split(" ");
    if (quota !== "max") {
      return Math.max(1, Math.floor(Number(quota) / Number(period)));
    }
    return undefined;
  } catch {
    // not cgroup v2, or no limit file present - fall through to cgroup v1
  }

  try {
    const quota = Number(readFileSync("/sys/fs/cgroup/cpu/cpu.cfs_quota_us", "utf-8").trim());
    const period = Number(readFileSync("/sys/fs/cgroup/cpu/cpu.cfs_period_us", "utf-8").trim());
    if (quota > 0 && period > 0) {
      return Math.max(1, Math.floor(quota / period));
    }
  } catch {
    // no cgroup CPU controller available at all
  }

  return undefined;
}

function describeAction(action: Action): string {
  switch (action.type) {
    case "move":
      return `Move "${action.characterId}" to node "${action.targetNodeId}"`;
    case "use_technique":
      return (
        `"${action.characterId}" attempts technique "${action.techniqueId}"` +
        (action.targetId ? ` on "${action.targetId}"` : "")
      );
    case "interact":
      return (
        `"${action.characterId}" attempts: ${action.description}` +
        (action.targetId ? ` (targeting "${action.targetId}")` : "") +
        (action.itemId ? ` (using "${action.itemId}")` : "")
      );
  }
}

export interface ToolCallRecord {
  name: string;
  params: unknown;
  result: unknown;
}

/**
 * How many times NarrationAuditor is given a chance to regenerate before
 * falling back to a deterministic, tool-result-only sentence.
 */
const MAX_NARRATION_RETRIES = 2;

/**
 * A deterministic, model-free fallback sentence built directly from an
 * `action` tool call's own params/result — used only when the narration
 * session couldn't produce a version NarrationAuditor accepted after
 * MAX_NARRATION_RETRIES attempts. Guarantees the player is never shown
 * narration confirmed to contradict what actually happened.
 */
export function buildFallbackNarration(actionCalls: ToolCallRecord[]): string {
  return actionCalls
    .map((call) => {
      const params = call.params as {
        type: string;
        characterId: string;
        description?: string;
        itemId?: string;
      };
      const result = call.result as ActionResult | RejectionResult;

      if (!result.success) {
        return `${params.characterId}'s action fails: ${result.reason}`;
      }

      const outcomeSuffix = result.outcome === "neutral" ? ", but it doesn't fully succeed" : "";
      switch (params.type) {
        case "move":
          return `${params.characterId} moves to "${result.nodeId}"${outcomeSuffix}.`;
        case "use_technique":
          return `${params.characterId} uses "${result.techniqueId}"${outcomeSuffix}.`;
        case "interact": {
          const itemSuffix = params.itemId ? ` (using "${params.itemId}")` : "";
          return `${params.characterId} attempts: ${params.description}${itemSuffix}${outcomeSuffix}.`;
        }
        default:
          return `${params.characterId}'s action succeeds${outcomeSuffix}.`;
      }
    })
    .join(" ");
}

export interface AiSessionOptions {
  modelPath: string;
  toolCtx: ToolContext;
  systemPrompt: string;
  /** Called after each tool call resolves — used by io/'s debug-dump mode. */
  onToolCall?: (call: ToolCallRecord) => void;
}

export interface AiSession {
  /** Sends one user turn through the agentic loop (check tools, then narration or an action). */
  prompt(input: string, turnTimestamp: number): Promise<string>;
  dispose(): Promise<void>;
}

/**
 * Loads the model, opens one context shared by the narrative session,
 * rules/'s validation session, and audit/'s narration-consistency session
 * (separate sequences, so none shares chat history with the others), and
 * wires up the beta tool set. Tier 1 per docs/ARCHITECTURE.md's AI
 * Orchestration: one model handles narrative, tool-call decisions, rule
 * validation, and narration auditing in sequence.
 */
export async function createAiSession(options: AiSessionOptions): Promise<AiSession> {
  const cpuQuota = detectCpuQuota();
  console.log(
    cpuQuota !== undefined
      ? `[cpu-quota] cgroup CPU quota detected: ${cpuQuota} core(s) — passing as maxThreads`
      : "[cpu-quota] no cgroup CPU quota found — using node-llama-cpp's default auto-detected thread count",
  );
  const llama = await getLlama({ maxThreads: cpuQuota });
  console.log(`[cpu-quota] llama.maxThreads resolved to: ${llama.maxThreads}`);
  const model = await llama.loadModel({ modelPath: options.modelPath });
  // Bounded explicitly: "auto" would try to size up to the model's full
  // trained context (often 128K+ tokens), and with no `sequences` count the
  // context defaults to 1 slot even though 3 independent sequences are
  // opened below — either gap alone can exhaust available RAM. 4096 turned
  // out too tight in practice — observed a real "context shift strategy did
  // not return a history that fits" crash on a single turn, since the
  // system prompt, the action tool's full 3-variant schema, and large
  // tool-result JSON payloads (further multiplied by this model's frequent
  // malformed-call retries) can exceed it before any real history
  // accumulates. 8192 costs ~1.4GB more KV cache across 3 sequences —
  // comfortably inside a 16GB container.
  const context = await model.createContext({ contextSize: 8192, sequences: 3 });

  const narrativeSequence = context.getSequence();
  const rulesSequence = context.getSequence();
  const auditSequence = context.getSequence();
  const ruleValidator = new RuleValidator(llama, rulesSequence);
  const narrationAuditor = new NarrationAuditor(llama, auditSequence);

  const turn = { timestamp: 0 };
  let turnToolCalls: ToolCallRecord[] = [];

  function record<Params, Result>(name: string, params: Params, result: Result): Result {
    turnToolCalls.push({ name, params, result });
    options.onToolCall?.({ name, params, result });
    return result;
  }

  const functions: ChatSessionModelFunctions = {
    get_scope: defineChatSessionFunction({
      description:
        "Get the current scope for a character: their location, its environment, " +
        "connections to other nodes, their current effective stats and inventory " +
        "(quantities remaining, what's equipped), and who else is present.",
      params: {
        type: "object",
        properties: { characterId: { type: "string" } },
      },
      handler: (params) =>
        record("get_scope", params, getScopeTool(options.toolCtx, params, turn.timestamp)),
    }),
    get_character_sheet: defineChatSessionFunction({
      description:
        "Get a character's static sheet: identity, abilities, skills, and known techniques.",
      params: {
        type: "object",
        properties: { characterId: { type: "string" } },
      },
      handler: (params) =>
        record("get_character_sheet", params, getCharacterSheetTool(options.toolCtx, params)),
    }),
    get_recent_dtm: defineChatSessionFunction({
      description: "Get the most recent events from this Experience's history log.",
      params: {
        type: "object",
        properties: { limit: { type: "number" } },
      },
      handler: (params) =>
        record("get_recent_dtm", params, getRecentDtmTool(options.toolCtx, params)),
    }),
    say: defineChatSessionFunction({
      description:
        "Have a character say something out loud — dialogue, taunts, questions, " +
        "declarations. Always permitted and recorded in history; unlike `action`, " +
        "this has no capability or legality gate.",
      params: {
        type: "object",
        properties: {
          characterId: { type: "string" },
          message: { type: "string" },
          targetId: {
            type: "string",
            description: "Character being spoken to, or an empty string if said to no one in particular.",
          },
        },
      },
      handler: (params) =>
        record("say", params, sayTool(options.toolCtx, params, turn.timestamp)),
    }),
    note_hazard: defineChatSessionFunction({
      description:
        "Log a one-off note to history about a notable environmental detail or " +
        "hazard — use this once, the first time you notice something worth " +
        "remembering, not every turn a character remains near it. Do not use " +
        "this for mechanically-defined effects (get_scope's environmentalCodes " +
        "with a resolvable effectId) — those apply automatically with no tool " +
        "call needed. This is only for flavor/unresolved hazards worth a " +
        "permanent note.",
      params: {
        type: "object",
        properties: {
          characterId: { type: "string" },
          description: { type: "string" },
        },
      },
      handler: (params) =>
        record("note_hazard", params, noteHazardTool(options.toolCtx, params, turn.timestamp)),
    }),
    action: defineChatSessionFunction({
      description:
        "Commit to an action that changes the world: move a character to a " +
        "connected node, have a character attempt a technique, or have a " +
        "character attempt anything else not covered by move/use_technique/say " +
        "(attacking, investigating, manipulating the environment, etc.) via " +
        "interact's free-form description. The character must actually know a " +
        "technique to use it (check get_character_sheet first if unsure) — " +
        "unknown techniques are rejected immediately, with a reason. For interact, " +
        "a named target must actually be present at the character's location, and " +
        "a named item must actually be in the character's inventory with quantity " +
        "> 0 (check get_character_sheet for what they're carrying) — using a " +
        "consumable item consumes one and applies its effect; using an equipment " +
        "item toggles it equipped/unequipped.",
      params: {
        oneOf: [
          {
            type: "object",
            properties: {
              type: { const: "move" },
              characterId: { type: "string" },
              targetNodeId: { type: "string" },
            },
          },
          {
            type: "object",
            properties: {
              type: { const: "use_technique" },
              characterId: { type: "string" },
              techniqueId: { type: "string" },
              targetId: {
                type: "string",
                description: "Target character's id, or an empty string if untargeted.",
              },
            },
          },
          {
            type: "object",
            properties: {
              type: { const: "interact" },
              characterId: { type: "string" },
              description: {
                type: "string",
                description: "Free-form description of what the character is attempting.",
              },
              targetId: {
                type: "string",
                description: "Target character's id, or an empty string if untargeted.",
              },
              itemId: {
                type: "string",
                description:
                  "Id of a carried item being used or equipped, or an empty string if none.",
              },
            },
          },
        ],
      },
      handler: async (params) => {
        const action: Action = { ...params, timestamp: turn.timestamp };
        if ("targetId" in action) {
          action.targetId = normalizeOptionalId(action.targetId);
        }
        if ("itemId" in action) {
          action.itemId = normalizeOptionalId(action.itemId);
        }

        const check = checkAction(options.toolCtx, action);
        if (!check.allowed) {
          const result = rejectAction(
            options.toolCtx,
            action.characterId,
            action.type,
            check.reason ?? "not allowed",
            action.timestamp,
          );
          return record("action", params, result);
        }

        const state = getState(
          options.toolCtx.dtm,
          options.toolCtx.loaded,
          options.toolCtx.world,
          action.timestamp,
          options.toolCtx.timeline.currentUnit(),
        );
        const validation = await ruleValidator.validate(
          { type: action.type, characterId: action.characterId, description: describeAction(action) },
          state,
        );
        if (validation.outcome === "invalid") {
          const result = rejectAction(
            options.toolCtx,
            action.characterId,
            action.type,
            validation.reason,
            action.timestamp,
          );
          return record("action", params, result);
        }

        return record("action", params, applyAction(options.toolCtx, action, validation.outcome));
      },
    }),
  };

  const session = new LlamaChatSession({
    contextSequence: narrativeSequence,
    systemPrompt: options.systemPrompt,
  });

  return {
    async prompt(input, turnTimestamp) {
      turn.timestamp = turnTimestamp;
      turnToolCalls = [];

      let narration = await session.prompt(input, { functions });

      const actionCalls = turnToolCalls.filter((call) => call.name === "action");
      let auditResult = { consistent: true } as Awaited<ReturnType<NarrationAuditor["audit"]>>;
      let retries = 0;

      // Only check turns where `action` was called — say/note_hazard/check
      // tools have no mechanical outcome a narration could contradict.
      if (actionCalls.length > 0) {
        auditResult = await narrationAuditor.audit(narration, turnToolCalls);

        while (!auditResult.consistent && retries < MAX_NARRATION_RETRIES) {
          retries += 1;
          const correction = [
            `Your narration didn't match what actually happened: ${auditResult.contradiction}`,
            `The actual tool results this turn: ${JSON.stringify(turnToolCalls)}`,
            "Rewrite your narration to accurately reflect this.",
          ].join("\n");
          // No `functions` here — this must not re-trigger tool calls and
          // re-apply state a second time, only regenerate the description.
          narration = await session.prompt(correction);
          auditResult = await narrationAuditor.audit(narration, turnToolCalls);
        }

        if (!auditResult.consistent) {
          narration = buildFallbackNarration(actionCalls);
        }
      }

      options.toolCtx.dtm.append({
        experienceId: options.toolCtx.loaded.experience.id,
        timestamp: turnTimestamp,
        type: "turn.audited",
        payload: {
          narration,
          toolCalls: turnToolCalls,
          checked: actionCalls.length > 0,
          consistent: auditResult.consistent,
          retries,
          usedFallback: actionCalls.length > 0 && !auditResult.consistent,
        },
      });

      return narration;
    },
    async dispose() {
      session.dispose();
      await context.dispose();
      await model.dispose();
    },
  };
}
