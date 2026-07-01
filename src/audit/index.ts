import {
  LlamaChatSession,
  type Llama,
  type LlamaContextSequence,
  type LlamaJsonSchemaGrammar,
} from "node-llama-cpp";

/** One tool call made during a turn, as recorded by ai/'s record() helper. */
export interface AuditedToolCall {
  name: string;
  params: unknown;
  result: unknown;
}

export interface AuditResult {
  consistent: boolean;
  /** Present when consistent is false — what the narration got wrong. */
  contradiction?: string;
}

const AUDIT_SCHEMA = {
  type: "object",
  properties: {
    consistent: { type: "boolean" },
    contradiction: { type: "string" },
  },
} as const;

/**
 * Checks whether a turn's narration accurately reflects what its tool calls
 * actually did — a defense against narration drift (e.g. describing a
 * change that was rejected as if it succeeded, or inventing details a tool
 * result doesn't support). Runs in its own isolated LlamaChatSession, the
 * same "separate validation prompt" pattern as rules/'s RuleValidator, kept
 * distinct from the narrative session so this check is never biased by the
 * same reasoning that produced the narration being checked.
 */
export class NarrationAuditor {
  private readonly session: LlamaChatSession;
  private readonly grammarPromise: Promise<LlamaJsonSchemaGrammar<typeof AUDIT_SCHEMA>>;

  constructor(llama: Llama, sequence: LlamaContextSequence) {
    this.session = new LlamaChatSession({
      contextSequence: sequence,
      systemPrompt:
        "You are a fact-checker for a text RPG's narration. You are given " +
        "the exact tool calls made this turn (with their actual results) " +
        "and the narration text the game master wrote to describe the " +
        "turn. Decide whether the narration is factually consistent with " +
        "the tool results:\n" +
        '"consistent: true" — the narration accurately reflects what the ' +
        "tool results say happened: success vs. failure, the actual " +
        "outcome (valid/neutral/rejected), and any specific facts the " +
        "results state (e.g. which node a move landed at). Stylistic " +
        "flourish, tone, and invented sensory detail are fine as long as " +
        "they don't contradict a fact the results establish.\n" +
        '"consistent: false" — the narration contradicts a tool result ' +
        "(e.g. describing a rejected or neutral action as a full success, " +
        "describing arrival somewhere other than the result's node, " +
        "asserting an effect or outcome the results don't support). Set " +
        "`contradiction` to a short, specific description of what's wrong " +
        "so the narration can be corrected.\n" +
        "Judge only factual consistency with the given tool results — " +
        "you are not judging writing quality.",
    });
    this.grammarPromise = llama.createGrammarForJsonSchema(AUDIT_SCHEMA);
  }

  async audit(narration: string, toolCalls: AuditedToolCall[]): Promise<AuditResult> {
    this.session.resetChatHistory();
    const grammar = await this.grammarPromise;

    const prompt = [
      `Tool calls this turn: ${JSON.stringify(toolCalls)}`,
      `Narration: ${narration}`,
      "Is the narration consistent with the tool results?",
    ].join("\n");

    const response = await this.session.prompt(prompt, { grammar });
    return grammar.parse(response);
  }
}
