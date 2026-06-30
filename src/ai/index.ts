import {
  getLlama,
  defineChatSessionFunction,
  LlamaChatSession,
  type ChatSessionModelFunctions,
} from "node-llama-cpp";
import type { Action, ToolContext } from "../tools/index.js";
import {
  getScopeTool,
  getCharacterSheetTool,
  getRecentDtmTool,
  checkAction,
  applyAction,
} from "../tools/index.js";
import { RuleValidator } from "../rules/index.js";
import { getState } from "../state/index.js";

function describeAction(action: Action): string {
  switch (action.type) {
    case "move":
      return `Move "${action.characterId}" to node "${action.targetNodeId}"`;
    case "use_technique":
      return (
        `"${action.characterId}" attempts technique "${action.techniqueId}"` +
        (action.targetId ? ` on "${action.targetId}"` : "")
      );
  }
}

export interface ToolCallRecord {
  name: string;
  params: unknown;
  result: unknown;
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
 * Loads the model, opens one context shared by the narrative session and
 * rules/'s validation session (separate sequences, so neither shares chat
 * history with the other), and wires up the beta tool set. Tier 1 per
 * docs/ARCHITECTURE.md's AI Orchestration: one model handles narrative,
 * tool-call decisions, and rule validation in sequence.
 */
export async function createAiSession(options: AiSessionOptions): Promise<AiSession> {
  const llama = await getLlama();
  const model = await llama.loadModel({ modelPath: options.modelPath });
  const context = await model.createContext();

  const narrativeSequence = context.getSequence();
  const rulesSequence = context.getSequence();
  const ruleValidator = new RuleValidator(llama, rulesSequence);

  const turn = { timestamp: 0 };

  function record<Params, Result>(name: string, params: Params, result: Result): Result {
    options.onToolCall?.({ name, params, result });
    return result;
  }

  const functions: ChatSessionModelFunctions = {
    get_scope: defineChatSessionFunction({
      description:
        "Get the current scope for a character: their location, its environment, " +
        "connections to other nodes, and who else is present.",
      params: {
        type: "object",
        properties: { characterId: { type: "string" } },
      },
      handler: (params) => record("get_scope", params, getScopeTool(options.toolCtx, params)),
    }),
    get_character_sheet: defineChatSessionFunction({
      description: "Get a character's static sheet: identity, abilities, and skills.",
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
    action: defineChatSessionFunction({
      description:
        "Commit to an action that changes the world: either move a character to a " +
        "connected node, or have a character attempt a technique. The character must " +
        "actually know the technique (check get_character_sheet first if unsure) — " +
        "unknown techniques are rejected immediately, with a reason.",
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
        ],
      },
      handler: async (params) => {
        const action: Action = { ...params, timestamp: turn.timestamp };

        const check = checkAction(options.toolCtx, action);
        if (!check.allowed) {
          return record("action", params, { success: false, reason: check.reason });
        }

        const state = getState(options.toolCtx.dtm, options.toolCtx.loaded);
        const validation = await ruleValidator.validate(
          { type: action.type, characterId: action.characterId, description: describeAction(action) },
          state,
        );
        if (!validation.valid) {
          return record("action", params, { success: false, reason: validation.reason });
        }

        return record("action", params, applyAction(options.toolCtx, action));
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
      return session.prompt(input, { functions });
    },
    async dispose() {
      session.dispose();
      await context.dispose();
      await model.dispose();
    },
  };
}
