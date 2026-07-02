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
import type { LlmDriver, ToolDef } from "./llmDriver.js";
import { createLlamaCppDriver, type LlamaCppBackendConfig } from "./llamaCppDriver.js";
import { createApiDriver, type ApiBackendConfig } from "./apiDriver.js";

/**
 * Which LlmDriver backs a session: a local node-llama-cpp model, or any
 * OpenAI-compatible chat completions API (Hugging Face Inference
 * Providers, OpenRouter, etc. - see apiDriver.ts).
 */
export type BackendConfig = ({ type: "llamaCpp" } & LlamaCppBackendConfig) | ({ type: "api" } & ApiBackendConfig);

async function createDriver(backend: BackendConfig): Promise<LlmDriver> {
  switch (backend.type) {
    case "llamaCpp":
      return createLlamaCppDriver(backend);
    case "api":
      return createApiDriver(backend);
  }
}

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
  backend: BackendConfig;
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
 * Starts the driver (local node-llama-cpp or a remote API - see
 * BackendConfig), opens independent chat sessions for the narrative
 * session, rules/'s validation session, and audit/'s narration-consistency
 * session (none shares history with the others), and wires up the beta
 * tool set. Tier 1 per docs/BACKEND_ARCHITECTURE.md's AI Orchestration: one model
 * handles narrative, tool-call decisions, rule validation, and narration
 * auditing in sequence.
 */
export async function createAiSession(options: AiSessionOptions): Promise<AiSession> {
  const driver = await createDriver(options.backend);

  const ruleValidator = new RuleValidator(driver);
  const narrationAuditor = new NarrationAuditor(driver);

  const turn = { timestamp: 0 };
  let turnToolCalls: ToolCallRecord[] = [];

  function record<Params, Result>(name: string, params: Params, result: Result): Result {
    turnToolCalls.push({ name, params, result });
    options.onToolCall?.({ name, params, result });
    return result;
  }

  // Grammar-constrained backends (see llamaCppDriver.ts) sample tool-call
  // arguments token-by-token against each parameter's JSON Schema. A bare
  // `{ type: "string" }` lets that sampling produce anything at all — the
  // observed failure mode was a 3B model emitting a characterId like
  // "goku}}; {" that's syntactically valid JSON but semantically garbage.
  // Enumerating the real, currently-valid ids for every id-shaped field
  // makes that class of output physically unreachable for a
  // grammar-constrained model, and is a harmless hint (not enforced, but
  // not harmful either) for API backends that don't grammar-constrain.
  const characterIds = options.toolCtx.loaded.characters.map((c) => c.id);
  const nodeIds = options.toolCtx.world.regions.flatMap((r) => r.nodes.map((n) => n.id));
  const techniqueIds = Array.from(
    new Set(options.toolCtx.loaded.characters.flatMap((c) => c.techniques.map((t) => t.id))),
  );
  const itemIds = options.toolCtx.loaded.ruleset.items.map((i) => i.id);
  const optionalCharacterTarget = [...characterIds, ""];
  const optionalItemTarget = [...itemIds, ""];

  const tools: ToolDef[] = [
    {
      name: "get_scope",
      description:
        "Get the current scope for a character: their location, its environment, " +
        "connections to other nodes, their current effective stats and inventory " +
        "(quantities remaining, what's equipped), and who else is present.",
      parameters: {
        type: "object",
        properties: { characterId: { type: "string", enum: characterIds } },
      },
      handler: (params) =>
        record(
          "get_scope",
          params,
          getScopeTool(options.toolCtx, params as { characterId: string }, turn.timestamp),
        ),
    },
    {
      name: "get_character_sheet",
      description: "Get a character's static sheet: identity, abilities, skills, and known techniques.",
      parameters: {
        type: "object",
        properties: { characterId: { type: "string", enum: characterIds } },
      },
      handler: (params) =>
        record(
          "get_character_sheet",
          params,
          getCharacterSheetTool(options.toolCtx, params as { characterId: string }),
        ),
    },
    {
      name: "get_recent_dtm",
      description: "Get the most recent events from this Experience's history log.",
      parameters: {
        type: "object",
        properties: { limit: { type: "number" } },
      },
      handler: (params) => record("get_recent_dtm", params, getRecentDtmTool(options.toolCtx, params as { limit: number })),
    },
    {
      name: "say",
      description:
        "Have a character say something out loud — dialogue, taunts, questions, " +
        "declarations. Always permitted and recorded in history; unlike `action`, " +
        "this has no capability or legality gate.",
      parameters: {
        type: "object",
        properties: {
          characterId: { type: "string", enum: characterIds },
          message: { type: "string" },
          targetId: {
            type: "string",
            enum: optionalCharacterTarget,
            description: "Character being spoken to, or an empty string if said to no one in particular.",
          },
        },
      },
      handler: (params) =>
        record(
          "say",
          params,
          sayTool(options.toolCtx, params as { characterId: string; message: string; targetId?: string }, turn.timestamp),
        ),
    },
    {
      name: "note_hazard",
      description:
        "Log a one-off note to history about a notable environmental detail or " +
        "hazard — use this once, the first time you notice something worth " +
        "remembering, not every turn a character remains near it. Do not use " +
        "this for mechanically-defined effects (get_scope's environmentalCodes " +
        "with a resolvable effectId) — those apply automatically with no tool " +
        "call needed. This is only for flavor/unresolved hazards worth a " +
        "permanent note.",
      parameters: {
        type: "object",
        properties: {
          characterId: { type: "string", enum: characterIds },
          description: { type: "string" },
        },
      },
      handler: (params) =>
        record(
          "note_hazard",
          params,
          noteHazardTool(options.toolCtx, params as { characterId: string; description: string }, turn.timestamp),
        ),
    },
    {
      name: "action",
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
      parameters: {
        oneOf: [
          {
            type: "object",
            properties: {
              type: { const: "move" },
              characterId: { type: "string", enum: characterIds },
              targetNodeId: { type: "string", enum: nodeIds },
            },
          },
          {
            type: "object",
            properties: {
              type: { const: "use_technique" },
              characterId: { type: "string", enum: characterIds },
              techniqueId: { type: "string", enum: techniqueIds },
              targetId: {
                type: "string",
                enum: optionalCharacterTarget,
                description: "Target character's id, or an empty string if untargeted.",
              },
            },
          },
          {
            type: "object",
            properties: {
              type: { const: "interact" },
              characterId: { type: "string", enum: characterIds },
              description: {
                type: "string",
                description: "Free-form description of what the character is attempting.",
              },
              targetId: {
                type: "string",
                enum: optionalCharacterTarget,
                description: "Target character's id, or an empty string if untargeted.",
              },
              itemId: {
                type: "string",
                enum: optionalItemTarget,
                description:
                  "Id of a carried item being used or equipped, or an empty string if none.",
              },
            },
          },
        ],
      },
      handler: async (params) => {
        const action: Action = { ...(params as object), timestamp: turn.timestamp } as Action;
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
    },
  ];

  const session = driver.createChatSession(options.systemPrompt);

  return {
    async prompt(input, turnTimestamp) {
      turn.timestamp = turnTimestamp;
      turnToolCalls = [];

      let narration = await session.prompt(input, tools);

      const actionCalls = turnToolCalls.filter((call) => call.name === "action");
      let auditResult = { consistent: true } as Awaited<ReturnType<NarrationAuditor["audit"]>>;
      let retries = 0;

      // Some backends (see apiDriver.ts's tool-calling loop) occasionally
      // return an empty final message after a round of tool calls — the
      // model considers the turn done without ever writing narration text.
      // Others (observed live: a free OpenRouter model that doesn't
      // reliably use the API's native tool-calling) fall back to writing a
      // textual pseudo-tool-call like `<tool_call>{"name": ...}</tool_call>`
      // directly into its content instead of populating tool_calls - since
      // that's not real JSON in the response's tool_calls field, apiDriver.ts
      // has no way to intercept it, and it would otherwise be shown to the
      // player verbatim. Neither case is ever acceptable narration
      // regardless of what the audit would otherwise say.
      const LEAKED_TOOL_CALL_PATTERN = /<\s*\/?\s*tool_call\s*>|<\|tool_call\|>|<\s*function_call\s*>/i;
      const isInvalidNarration = (text: string) =>
        text.trim().length === 0 || LEAKED_TOOL_CALL_PATTERN.test(text);
      const invalidReason = "Narration was empty, or leaked raw tool-call syntax instead of prose.";

      // Only check turns where `action` was called — say/note_hazard/check
      // tools have no mechanical outcome a narration could contradict.
      if (actionCalls.length > 0) {
        auditResult = isInvalidNarration(narration)
          ? { consistent: false, contradiction: invalidReason }
          : await narrationAuditor.audit(narration, turnToolCalls);

        while (!auditResult.consistent && retries < MAX_NARRATION_RETRIES) {
          retries += 1;
          const correction = [
            `Your narration didn't match what actually happened: ${auditResult.contradiction}`,
            `The actual tool results this turn: ${JSON.stringify(turnToolCalls)}`,
            "Rewrite your narration to accurately reflect this, as plain prose only - no tool-call syntax.",
          ].join("\n");
          // No `tools` here — this must not re-trigger tool calls and
          // re-apply state a second time, only regenerate the description.
          narration = await session.prompt(correction);
          auditResult = isInvalidNarration(narration)
            ? { consistent: false, contradiction: invalidReason }
            : await narrationAuditor.audit(narration, turnToolCalls);
        }

        if (!auditResult.consistent) {
          narration = buildFallbackNarration(actionCalls);
        }
      } else if (isInvalidNarration(narration)) {
        // No action this turn (say/note_hazard/check only), but the model
        // still returned no usable text — ask once more instead of leaving
        // the player with an empty or garbled response.
        narration = await session.prompt(
          "Your last reply had no narration text (or wasn't valid prose). Describe what happened in plain text, with no tool-call syntax.",
        );
        if (isInvalidNarration(narration)) {
          // Guarantees the player is never shown a blank or garbled reply,
          // even when the model repeatedly fails to produce real prose.
          narration = "The Engine couldn't produce a response for that — try rephrasing what your character does.";
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
      await driver.dispose();
    },
  };
}
