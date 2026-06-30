import {
  LlamaChatSession,
  type Llama,
  type LlamaContextSequence,
  type LlamaJsonSchemaGrammar,
} from "node-llama-cpp";
import type { StateSnapshot } from "../state/index.js";

/** A proposed action tool call, as the AI committed to it this turn. */
export interface ProposedAction {
  type: string;
  characterId: string;
  description: string;
}

export interface RuleValidation {
  valid: boolean;
  reason: string;
}

const VALIDATION_SCHEMA = {
  type: "object",
  properties: {
    valid: { type: "boolean" },
    reason: { type: "string" },
  },
} as const;

/**
 * Validates proposed actions by asking the same model a separate, isolated
 * prompt — its own chat session, history reset between calls — whether the
 * action is legal given the current state. Kept distinct from the
 * narrative session so rules validation never leaks into, or is biased by,
 * the ongoing narration (docs/ARCHITECTURE.md Turn Flow, step 5).
 */
export class RuleValidator {
  private readonly session: LlamaChatSession;
  private readonly grammarPromise: Promise<LlamaJsonSchemaGrammar<typeof VALIDATION_SCHEMA>>;

  constructor(llama: Llama, sequence: LlamaContextSequence) {
    this.session = new LlamaChatSession({
      contextSequence: sequence,
      systemPrompt:
        "You are the rules referee for a turn-based RPG engine. Given the " +
        "current game state and a proposed action, decide whether the " +
        "action is valid. Respond only with the validation result.",
    });
    this.grammarPromise = llama.createGrammarForJsonSchema(VALIDATION_SCHEMA);
  }

  async validate(action: ProposedAction, state: StateSnapshot): Promise<RuleValidation> {
    this.session.resetChatHistory();
    const grammar = await this.grammarPromise;

    const prompt = [
      `Current state: ${JSON.stringify(state)}`,
      `Proposed action: ${JSON.stringify(action)}`,
      "Is this action valid?",
    ].join("\n");

    const response = await this.session.prompt(prompt, { grammar });
    return grammar.parse(response);
  }
}
