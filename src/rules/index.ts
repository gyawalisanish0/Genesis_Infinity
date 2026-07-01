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
  /**
   * "valid" — the action succeeds as attempted.
   * "neutral" — the action is attempted but doesn't fully succeed given
   *   current conditions/state (a fizzle) — still happens, but with no or
   *   reduced effect. Distinct from "invalid": this is not a rejection.
   * "invalid" — the action is illegal or impossible given current state
   *   and does not happen at all.
   */
  outcome: "valid" | "neutral" | "invalid";
  reason: string;
}

const VALIDATION_SCHEMA = {
  type: "object",
  properties: {
    outcome: { enum: ["valid", "neutral", "invalid"] },
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
        "You are the rules referee for a turn-based RPG engine. You are " +
        "given the full current game state — every character's sheet " +
        "(abilities, skills, known techniques), current position, and any " +
        "active debuffs — plus a proposed action from one character. " +
        "Decide exactly one outcome:\n" +
        '"valid" — the action succeeds as attempted: it is mechanically ' +
        "possible given the acting character's stats/abilities/techniques " +
        "and current position, and nothing in state prevents it.\n" +
        '"neutral" — the character attempts it, but state makes it ' +
        "uncertain, risky, or only partially achievable: it happens, but " +
        "doesn't fully land or accomplish what was intended. Not a " +
        "rejection.\n" +
        '"invalid" — the action is mechanically impossible, contradicts ' +
        "current state (wrong location, target not present, requires a " +
        "capability the sheet doesn't show), or is otherwise forbidden. " +
        "Nothing happens.\n" +
        "Judge mechanical plausibility against the given state only — " +
        "tone, prose quality, and how exciting an action sounds are the " +
        "narrator's job, not yours.\n" +
        "Examples:\n" +
        "- A high-Strength character forcing open a jammed door within " +
        "reach: valid.\n" +
        "- A character with no ranged capability trying to strike a " +
        "target far across open ground with nothing described to close " +
        "the distance: neutral — they try, but it doesn't connect.\n" +
        "- Acting from a node the character isn't at, or targeting a " +
        "character who isn't present: invalid.\n" +
        "Respond only with the validation result.",
    });
    this.grammarPromise = llama.createGrammarForJsonSchema(VALIDATION_SCHEMA);
  }

  async validate(action: ProposedAction, state: StateSnapshot): Promise<RuleValidation> {
    this.session.resetChatHistory();
    const grammar = await this.grammarPromise;

    const prompt = [
      `Current state: ${JSON.stringify(state)}`,
      `Proposed action: ${JSON.stringify(action)}`,
      "Is this action valid, neutral, or invalid given the current state?",
    ].join("\n");

    const response = await this.session.prompt(prompt, { grammar });
    return grammar.parse(response);
  }
}
