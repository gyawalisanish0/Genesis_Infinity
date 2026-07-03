import type { ChatDriverSession, LlmDriver } from "../ai/llmDriver.js";

/**
 * Compresses recent narration text into a short recap, so ai/'s narrative
 * session can fold old turns into a running summary instead of letting
 * conversational history grow forever (see docs/BACKEND_ARCHITECTURE.md's
 * Context Efficiency section for the measured problem this solves). Runs in
 * its own isolated chat session, the same "separate validation prompt"
 * pattern as rules/'s RuleValidator and audit/'s NarrationAuditor - kept
 * distinct from the narrative session so summarization never leaks into,
 * or is biased by, the ongoing narration. Backend-agnostic: works against a
 * local node-llama-cpp model or a remote API-backed model, since it only
 * depends on LlmDriver (see ai/llmDriver.ts).
 *
 * Used at two levels by ai/'s turn loop, both through this same method:
 * - Every few turns, compressing that span's raw narrations into one
 *   ~50-word "subblock" summary.
 * - Every several subblocks, compressing those subblock summaries into one
 *   coarser "block" summary, so long-run context growth stays bounded
 *   rather than accumulating one subblock per few turns forever.
 */
export class Summarizer {
  private readonly session: ChatDriverSession;

  constructor(driver: LlmDriver) {
    this.session = driver.createChatSession(
      "You compress recent events from a text RPG session into a short " +
        "recap, for the game master's own memory - not shown to the " +
        "player. Preserve concrete facts a game master would need to stay " +
        "consistent: who did what, outcomes (hit/missed/succeeded/failed), " +
        "injuries or state changes, and location changes. Drop flavor " +
        "prose and phrasing - keep only what's factually load-bearing. " +
        "Respond with only the recap text, no preamble.",
    );
  }

  async summarize(items: string[], targetWords: number): Promise<string> {
    this.session.resetHistory();

    const prompt = [
      `Recent events, in order:\n${items.map((item, i) => `${i + 1}. ${item}`).join("\n")}`,
      `Summarize these in about ${targetWords} words.`,
    ].join("\n");

    return this.session.prompt(prompt);
  }
}
