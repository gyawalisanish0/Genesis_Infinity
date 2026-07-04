import type { Action, ActionOutcome, ActionResult, RejectionResult, ToolContext } from "../tools/index.js";
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
import { Summarizer } from "../summarizer/index.js";
import { getState, type StateSnapshot } from "../state/index.js";
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

/**
 * Trims a StateSnapshot down to only the characters actually relevant to a
 * proposed action (the actor, plus its target if any) before it's sent to
 * rules/'s validator. `rules/`'s judgment only ever depends on those two
 * characters' state - serializing every other character in the Experience
 * into that prompt is dead weight that scales with cast size regardless of
 * relevance (measured: ~1.7K tokens per call in a 2-character fixture,
 * would scale linearly with a larger cast).
 */
function scopeStateToAction(state: StateSnapshot, action: Action): StateSnapshot {
  const relevantIds = new Set<string>([action.characterId]);
  if ("targetId" in action && action.targetId) {
    relevantIds.add(action.targetId);
  }
  return {
    ...state,
    characters: state.characters.filter((c) => relevantIds.has(c.sheet.id)),
  };
}

function rollD20(): number {
  return 1 + Math.floor(Math.random() * 20);
}

/**
 * Overrides rules/'s own valid/neutral guess with a real dice roll once a
 * target is named and legal (rules/'s "invalid" gate already ran and
 * passed) — d20 plus the acting character's applicableSkillId value
 * (rules/'s own categorical judgment) against the target's effective
 * armorClass as DC, reusing real sheet/effectiveStats data instead of a
 * new invented difficulty scale (see docs/BACKEND_ARCHITECTURE.md's
 * Dynamic Timeline-Driven Turn Engine). Returns undefined — rules/'s own
 * judgment stands unchanged — when there's no target or the target has no
 * armorClass to roll against; `move` is never rolled, since its Action
 * variant has no targetId at all. Also skipped for a `use_technique` whose
 * TechniqueDef has no `effectId` (e.g. Instant Transmission, a pure
 * `relocatesToTarget` teleport with nothing to resist) — an "attack roll
 * vs armor class" only makes sense for a technique that actually has a
 * mechanical effect to land.
 */
function resolveRoll(
  ctx: ToolContext,
  state: StateSnapshot,
  action: Action,
  applicableSkillId: string | undefined,
): { outcome: ActionOutcome; margin: number } | undefined {
  if (!("targetId" in action) || !action.targetId) {
    return undefined;
  }

  if (action.type === "use_technique") {
    const actorSheet = ctx.loaded.characters.find((c) => c.id === action.characterId);
    const technique = actorSheet?.techniques.find((t) => t.id === action.techniqueId);
    if (!technique?.effectId) {
      return undefined;
    }
  }

  const targetArmorClass = state.characters.find((c) => c.sheet.id === action.targetId)?.effectiveStats.armorClass;
  if (targetArmorClass === undefined) {
    return undefined;
  }

  const actorSheet = ctx.loaded.characters.find((c) => c.id === action.characterId);
  const skillValue = actorSheet?.skills.find((s) => s.id === applicableSkillId)?.value ?? 0;

  const margin = rollD20() + skillValue - targetArmorClass;
  return { outcome: margin >= 0 ? "valid" : "neutral", margin };
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

export interface TurnResult {
  narration: string;
  /** A reasoning model's chain-of-thought for this turn, if any (see extractReasoning). */
  reasoning?: string;
}

const THINK_BLOCK_PATTERN = /<think>([\s\S]*?)<\/think>/gi;

/**
 * Reasoning models (e.g. DeepSeek R1) emit their chain-of-thought as a
 * literal <think>...</think> block inline in the same message content as
 * the actual reply - there's no separate API field to route it through for
 * models exposed this way (observed live via Hugging Face's router). Strips
 * it out of what's treated as narration and returns it separately so
 * callers can show it as optional, clearly-labeled context (e.g. a
 * collapsible section) rather than either leaking raw reasoning into the
 * player-facing narration or silently discarding it.
 */
function extractReasoning(text: string): { reasoning?: string; narration: string } {
  const reasoningParts: string[] = [];
  const narration = text
    .replace(THINK_BLOCK_PATTERN, (_match, inner: string) => {
      reasoningParts.push(inner.trim());
      return "";
    })
    .trim();
  return reasoningParts.length > 0 ? { reasoning: reasoningParts.join("\n\n"), narration } : { narration };
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
  prompt(input: string, turnTimestamp: number): Promise<TurnResult>;
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
  const summarizer = new Summarizer(driver);

  // Context-efficiency: the narrative session's history would otherwise
  // grow every turn forever (see docs/BACKEND_ARCHITECTURE.md's Context
  // Efficiency section). Every SUBBLOCK_TURN_COUNT turns, recent
  // narrations are compressed into one ~SUBBLOCK_TARGET_WORDS-word
  // "subblock" summary; every SUBBLOCKS_PER_BLOCK subblocks, those are
  // compressed again into one coarser "block" summary, so long-run growth
  // stays bounded (logarithmic-ish) rather than accumulating one subblock
  // per few turns forever. blockSummaries + subblockSummaries together are
  // the full current recap, resent via compactToSummary each time either
  // level rolls up.
  const SUBBLOCK_TURN_COUNT = 5;
  const SUBBLOCK_TARGET_WORDS = 50;
  const SUBBLOCKS_PER_BLOCK = 10;
  const BLOCK_TARGET_WORDS = 75;
  let pendingNarrations: string[] = [];
  let subblockSummaries: string[] = [];
  let blockSummaries: string[] = [];

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
            enum: characterIds,
            description: "Character being spoken to. Omit this field entirely if said to no one in particular.",
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
                enum: characterIds,
                description: "Target character's id. Omit this field entirely if untargeted.",
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
                enum: characterIds,
                description: "Target character's id. Omit this field entirely if untargeted.",
              },
              itemId: {
                type: "string",
                enum: itemIds,
                description: "Id of a carried item being used or equipped. Omit this field entirely if none.",
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
          scopeStateToAction(state, action),
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

        const rolled = resolveRoll(options.toolCtx, state, action, validation.applicableSkillId);

        return record(
          "action",
          params,
          applyAction(options.toolCtx, action, rolled?.outcome ?? validation.outcome, rolled?.margin),
        );
      },
    },
  ];

  const session = driver.createChatSession(options.systemPrompt);

  return {
    async prompt(input, turnTimestamp) {
      turn.timestamp = turnTimestamp;
      turnToolCalls = [];

      let { reasoning, narration } = extractReasoning(await session.prompt(input, tools));

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
      // Within that, the full LLM-based audit call is itself skipped when
      // every action this turn was a clean, fully-successful outcome
      // (result.success && outcome === "valid") — narration drift is far
      // more likely on a rejected or "neutral" (didn't fully land) result,
      // where a model is tempted to narrate the success it wanted rather
      // than what actually happened. isInvalidNarration's cheap, local
      // blank/leaked-syntax check still always runs regardless — this only
      // skips the separate, costlier narrationAuditor.audit() API call.
      const needsFullAudit = actionCalls.some((call) => {
        const result = call.result as ActionResult | RejectionResult;
        return !result.success || result.outcome === "neutral";
      });
      const auditOrTrust = () =>
        needsFullAudit ? narrationAuditor.audit(narration, turnToolCalls) : Promise.resolve({ consistent: true as const });

      if (actionCalls.length > 0) {
        auditResult = isInvalidNarration(narration)
          ? { consistent: false, contradiction: invalidReason }
          : await auditOrTrust();

        while (!auditResult.consistent && retries < MAX_NARRATION_RETRIES) {
          retries += 1;
          const correction = [
            `Your narration didn't match what actually happened: ${auditResult.contradiction}`,
            `The actual tool results this turn: ${JSON.stringify(turnToolCalls)}`,
            "Rewrite your narration to accurately reflect this, as plain prose only - no tool-call syntax.",
          ].join("\n");
          // No `tools` here — this must not re-trigger tool calls and
          // re-apply state a second time, only regenerate the description.
          ({ reasoning, narration } = extractReasoning(await session.prompt(correction)));
          auditResult = isInvalidNarration(narration)
            ? { consistent: false, contradiction: invalidReason }
            : await auditOrTrust();
        }

        if (!auditResult.consistent) {
          narration = buildFallbackNarration(actionCalls);
          reasoning = undefined; // a deterministic fallback sentence has no corresponding reasoning
        }
      } else if (isInvalidNarration(narration)) {
        // No action this turn (say/note_hazard/check only), but the model
        // still returned no usable text — ask once more instead of leaving
        // the player with an empty or garbled response.
        ({ reasoning, narration } = extractReasoning(
          await session.prompt(
            "Your last reply had no narration text (or wasn't valid prose). Describe what happened in plain text, with no tool-call syntax.",
          ),
        ));
        if (isInvalidNarration(narration)) {
          // Guarantees the player is never shown a blank or garbled reply,
          // even when the model repeatedly fails to produce real prose.
          narration = "The Engine couldn't produce a response for that — try rephrasing what your character does.";
          reasoning = undefined;
        }
      }

      options.toolCtx.dtm.append({
        experienceId: options.toolCtx.loaded.experience.id,
        timestamp: turnTimestamp,
        type: "turn.audited",
        payload: {
          narration,
          toolCalls: turnToolCalls,
          checked: actionCalls.length > 0 && needsFullAudit,
          consistent: auditResult.consistent,
          retries,
          usedFallback: actionCalls.length > 0 && !auditResult.consistent,
        },
      });

      // Single end-of-turn context-maintenance step (see llmDriver.ts's
      // compactContext doc comment) - called exactly once per turn, every
      // turn, so there's one pipeline deciding what to shrink and when,
      // not a driver-internal mechanism plus a separate caller-triggered
      // one running independently of each other.
      pendingNarrations.push(narration);
      let rollupSummary: string | undefined;
      if (pendingNarrations.length >= SUBBLOCK_TURN_COUNT) {
        subblockSummaries.push(await summarizer.summarize(pendingNarrations, SUBBLOCK_TARGET_WORDS));
        pendingNarrations = [];

        if (subblockSummaries.length >= SUBBLOCKS_PER_BLOCK) {
          blockSummaries.push(await summarizer.summarize(subblockSummaries, BLOCK_TARGET_WORDS));
          subblockSummaries = [];
        }

        rollupSummary = [...blockSummaries, ...subblockSummaries].join(" ");
      }
      session.compactContext?.(rollupSummary);

      return { narration, reasoning };
    },
    async dispose() {
      await driver.dispose();
    },
  };
}
