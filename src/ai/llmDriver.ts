/**
 * Shared abstraction over "an LLM capable of running this engine's turn
 * loop" — implemented once by llamaCppDriver.ts (local, via node-llama-cpp)
 * and once by apiDriver.ts (remote, via any OpenAI-compatible chat
 * completions API — Hugging Face Inference Providers, OpenRouter, etc.).
 * ai/index.ts's turn loop, rules/'s RuleValidator, and audit/'s
 * NarrationAuditor all depend on this instead of on node-llama-cpp
 * directly, so the engine can run against either a local embedded model or
 * a remote hosted one without touching their logic.
 */

/** A JSON Schema object — used both for tool parameter schemas and for promptForJson's forced-output schema. */
export type JsonSchema = Record<string, unknown>;

export interface ToolDef {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** Executes the tool given the model's (already schema-shaped) arguments. */
  handler: (args: unknown) => unknown | Promise<unknown>;
}

/**
 * One conversational session against a model. Stateful (history held
 * internally) since that's the natural fit for a local node-llama-cpp
 * session; the API backend presents the same shape by wrapping an
 * internally-held message array over a stateless HTTP API.
 */
export interface ChatDriverSession {
  /**
   * Sends one user turn. If `tools` is given, the driver runs the full
   * tool-calling loop internally (calling each tool's handler as the model
   * requests it, feeding results back, repeating until the model responds
   * with plain text) and returns only the final text.
   */
  prompt(input: string, tools?: ToolDef[]): Promise<string>;
  /**
   * A single, schema-forced-JSON completion — used by rules/'s
   * RuleValidator and audit/'s NarrationAuditor for their tri-state/boolean
   * judgments. Does not consult or alter the session's ongoing history;
   * callers that want statelessness should call resetHistory() first (same
   * pattern as today's session.resetChatHistory() + session.prompt()).
   */
  promptForJson<T>(input: string, schema: JsonSchema): Promise<T>;
  /** Clears conversational history back to just the system prompt. */
  resetHistory(): void;
  /**
   * Collapses the session's entire history (since the system prompt) down
   * to a single message containing `summaryText` — used by ai/'s narrative
   * session to fold old turns into a running recap instead of letting
   * conversational history grow forever (see docs/BACKEND_ARCHITECTURE.md's
   * Context Efficiency section). Optional: a driver that can't or doesn't
   * yet support this (llamaCppDriver.ts's local sessions, whose context is
   * managed internally by node-llama-cpp) simply leaves it unimplemented —
   * callers use `session.compactToSummary?.(...)`.
   */
  compactToSummary?(summaryText: string): void;
}

export interface LlmDriver {
  /** Starts a new independent chat session with the given system prompt. */
  createChatSession(systemPrompt: string): ChatDriverSession;
  /** Releases any underlying resources (model, context, HTTP client, etc). */
  dispose(): Promise<void>;
}
