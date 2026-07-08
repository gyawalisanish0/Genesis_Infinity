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
   *
   * `options.maxTokens` caps generation. On the local backend it bounds the
   * whole prompt() call's generation (tool-call rounds + final narration
   * combined — see llamaCppDriver.ts); on the API backend it's a per-request
   * cap, so it effectively bounds the final narration round (tool-call rounds
   * generate little). Meant as a generous safety bound against a runaway
   * narration (unbounded CPU generation is the worst-case latency spike on a
   * local model), not a tight per-turn budget — a truncated narration still
   * degrades gracefully via ai/'s empty/garbled-narration fallback.
   */
  prompt(input: string, tools?: ToolDef[], options?: { maxTokens?: number }): Promise<string>;
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
   * The single end-of-turn context-maintenance step — called exactly once
   * per turn by ai/'s turn loop, never automatically inside prompt() itself,
   * so all context-shrinking behavior lives in one visible place instead of
   * being split between a driver-internal mechanism and a separate
   * caller-triggered one (see docs/BACKEND_ARCHITECTURE.md's Context
   * Efficiency section).
   * - Called with no argument on an ordinary turn: compacts that turn's own
   *   tool-call results now that they've served their purpose (fed the
   *   model's next reply) - keeping their full content around only grows
   *   every later request for no ongoing benefit.
   * - Called with `summary` on a rollup turn (ai/'s Summarizer produced a
   *   new subblock/block recap): collapses the *entire* history down to one
   *   message containing it, superseding the plain per-turn compaction for
   *   that call - a recap already accounts for everything it replaces.
   * Optional: a driver that can't or doesn't yet support this
   * (llamaCppDriver.ts's local sessions, whose context is managed
   * internally by node-llama-cpp) simply leaves it unimplemented — callers
   * use `session.compactContext?.(...)`.
   */
  compactContext?(summary?: string): void;
  /**
   * Returns whatever scarce backing resource this session holds (e.g. a
   * local llamaCppDriver.ts sequence) to the driver's pool, so a later
   * createNarrativeSession call can reuse it for a different character —
   * see ai/index.ts's per-character session eviction. Async because a
   * real release (clearing a sequence's KV cache) genuinely awaits
   * completion before the resource is safe to hand to someone else.
   * Optional: absent/no-op for a backend with nothing scarce to release
   * (apiDriver.ts's sessions are just in-memory arrays) or for a session
   * created via plain createChatSession, which is never released.
   */
  release?(): Promise<void>;
}

export interface LlmDriver {
  /**
   * Starts a new, permanent chat session with the given system prompt —
   * used only for the engine's three fixed, character-agnostic roles
   * (rules/'s RuleValidator, audit/'s NarrationAuditor, summarizer/'s
   * Summarizer), each of which calls resetHistory() before every use and
   * lives for the whole session; never released.
   */
  createChatSession(systemPrompt: string): ChatDriverSession;
  /**
   * Starts a reusable, per-character narrative session — one per
   * character, as opposed to createChatSession's fixed shared roles. A
   * backend with no scarce resource to manage (apiDriver.ts) can just
   * create these identically to createChatSession, kept resident forever.
   * A backend with a bounded resource (llamaCppDriver.ts's sequences)
   * draws from a smaller dedicated pool — see ai/index.ts's per-character
   * eviction, which calls session.release() before reusing the pool slot
   * for a different character.
   */
  createNarrativeSession(systemPrompt: string): ChatDriverSession;
  /** Releases any underlying resources (model, context, HTTP client, etc). */
  dispose(): Promise<void>;
}

/**
 * Engine default for LlamaCppBackendConfig.narrativeWorkerSequences — how many
 * dedicated narrative sequences the local llama.cpp pool pre-allocates.
 * Covers "player + one active NPC" resident with zero eviction cost in a
 * typical small cast; a larger simultaneous cast starts paying the bounded
 * reload cost ai/index.ts's eviction policy caps (see docs/BACKEND_ARCHITECTURE.md).
 *
 * Defined here, in the backend-agnostic module, rather than in llamaCppDriver.ts,
 * so core/ and ai/ can read it without importing llamaCppDriver.ts — which would
 * eagerly load the node-llama-cpp native addon at process start (see the
 * lazy-load note in ai/index.ts's createDriver).
 */
export const DEFAULT_NARRATIVE_WORKER_SEQUENCES = 2;
