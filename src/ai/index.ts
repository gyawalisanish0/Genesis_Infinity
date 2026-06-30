import {
  getLlama,
  defineChatSessionFunction,
  LlamaChatSession,
  type ChatSessionModelFunctions,
} from "node-llama-cpp";
import type { ToolContext } from "../tools/index.js";
import { getScopeTool, getCharacterSheetTool, getRecentDtmTool, moveTool } from "../tools/index.js";
import { RuleValidator } from "../rules/index.js";
import { getState } from "../state/index.js";

export interface AiSessionOptions {
  modelPath: string;
  toolCtx: ToolContext;
  systemPrompt: string;
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

  const functions: ChatSessionModelFunctions = {
    get_scope: defineChatSessionFunction({
      description:
        "Get the current scope for a character: their location, its environment, " +
        "connections to other nodes, and who else is present.",
      params: {
        type: "object",
        properties: { characterId: { type: "string" } },
      },
      handler: (params) => getScopeTool(options.toolCtx, params),
    }),
    get_character_sheet: defineChatSessionFunction({
      description: "Get a character's static sheet: identity, abilities, and skills.",
      params: {
        type: "object",
        properties: { characterId: { type: "string" } },
      },
      handler: (params) => getCharacterSheetTool(options.toolCtx, params),
    }),
    get_recent_dtm: defineChatSessionFunction({
      description: "Get the most recent events from this Experience's history log.",
      params: {
        type: "object",
        properties: { limit: { type: "number" } },
      },
      handler: (params) => getRecentDtmTool(options.toolCtx, params),
    }),
    move: defineChatSessionFunction({
      description: "Move a character to a connected node.",
      params: {
        type: "object",
        properties: {
          characterId: { type: "string" },
          targetNodeId: { type: "string" },
        },
      },
      handler: async (params) => {
        const state = getState(options.toolCtx.dtm, options.toolCtx.loaded);
        const validation = await ruleValidator.validate(
          {
            type: "move",
            characterId: params.characterId,
            description: `Move "${params.characterId}" to node "${params.targetNodeId}"`,
          },
          state,
        );
        if (!validation.valid) {
          return { success: false, reason: validation.reason };
        }
        return moveTool(options.toolCtx, {
          characterId: params.characterId,
          targetNodeId: params.targetNodeId,
          timestamp: turn.timestamp,
        });
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
