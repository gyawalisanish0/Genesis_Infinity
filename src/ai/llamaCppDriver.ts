import { readFileSync } from "node:fs";
import {
  getLlama,
  defineChatSessionFunction,
  LlamaChatSession,
  type Llama,
  type LlamaContextSequence,
  type LlamaJsonSchemaGrammar,
} from "node-llama-cpp";
import type { ChatDriverSession, JsonSchema, LlmDriver, ToolDef } from "./llmDriver.js";

/**
 * Detects the container's actual CPU quota from cgroup limits, if any.
 * /proc/cpuinfo (and thus node-llama-cpp's own core auto-detection) reports
 * the host machine's full physical core count even inside a quota-limited
 * container — observed directly on a Hugging Face CPU Space that reports 16
 * cores but is only entitled to 2 cores' worth of CPU time. Letting
 * node-llama-cpp size its thread pool off the wrong number causes
 * oversubscription and CFS-scheduler throttling stalls rather than a real
 * speedup. Returns undefined (no override, current auto-detect behavior
 * unchanged) when there's no cgroup limit or this isn't a cgroup-managed
 * environment at all — e.g. this repo's own dev sandbox, which reports an
 * unlimited quota (-1) and should keep using all its actual cores.
 */
function detectCpuQuota(): number | undefined {
  try {
    const [quota, period] = readFileSync("/sys/fs/cgroup/cpu.max", "utf-8").trim().split(" ");
    if (quota !== "max") {
      return Math.max(1, Math.floor(Number(quota) / Number(period)));
    }
    return undefined;
  } catch {
    // not cgroup v2, or no limit file present - fall through to cgroup v1
  }

  try {
    const quota = Number(readFileSync("/sys/fs/cgroup/cpu/cpu.cfs_quota_us", "utf-8").trim());
    const period = Number(readFileSync("/sys/fs/cgroup/cpu/cpu.cfs_period_us", "utf-8").trim());
    if (quota > 0 && period > 0) {
      return Math.max(1, Math.floor(quota / period));
    }
  } catch {
    // no cgroup CPU controller available at all
  }

  return undefined;
}

class LlamaCppChatSession implements ChatDriverSession {
  private readonly session: LlamaChatSession;
  private readonly llama: Llama;
  private readonly grammarCache = new WeakMap<JsonSchema, Promise<LlamaJsonSchemaGrammar<never>>>();

  constructor(llama: Llama, sequence: LlamaContextSequence, systemPrompt: string) {
    this.llama = llama;
    this.session = new LlamaChatSession({ contextSequence: sequence, systemPrompt });
  }

  async prompt(input: string, tools?: ToolDef[]): Promise<string> {
    if (!tools || tools.length === 0) {
      return this.session.prompt(input);
    }

    const functions: Record<string, ReturnType<typeof defineChatSessionFunction>> = {};
    for (const tool of tools) {
      functions[tool.name] = defineChatSessionFunction({
        description: tool.description,
        // node-llama-cpp's own schema type is stricter (literal-typed) than
        // our generic JsonSchema - the runtime shapes match, so this is a
        // deliberate boundary cast rather than a real type mismatch.
        params: tool.parameters as never,
        handler: tool.handler as never,
      });
    }
    return this.session.prompt(input, { functions });
  }

  async promptForJson<T>(input: string, schema: JsonSchema): Promise<T> {
    let grammarPromise = this.grammarCache.get(schema);
    if (!grammarPromise) {
      grammarPromise = this.llama.createGrammarForJsonSchema(schema as never);
      this.grammarCache.set(schema, grammarPromise);
    }
    const grammar = await grammarPromise;
    const response = await this.session.prompt(input, { grammar });
    return grammar.parse(response) as T;
  }

  resetHistory(): void {
    this.session.resetChatHistory();
  }
}

export interface LlamaCppBackendConfig {
  modelPath: string;
}

/**
 * LlmDriver implementation backed by a local node-llama-cpp model.
 * Pre-allocates 3 sequences on one context (matching ai/'s narrative/
 * rules/audit sessions) - contextSize is bounded explicitly rather than
 * "auto" (which tries to size up to the model's full trained context,
 * often 128K+ tokens) for the same reason `sequences` is bounded: either
 * gap can exhaust available RAM or, if too small, overflow mid-turn (see
 * the 4096 -> 8192 bump after a real crash on a Hugging Face CPU Space).
 */
export async function createLlamaCppDriver(config: LlamaCppBackendConfig): Promise<LlmDriver> {
  const cpuQuota = detectCpuQuota();
  console.log(
    cpuQuota !== undefined
      ? `[cpu-quota] cgroup CPU quota detected: ${cpuQuota} core(s) — passing as maxThreads`
      : "[cpu-quota] no cgroup CPU quota found — using node-llama-cpp's default auto-detected thread count",
  );
  const llama = await getLlama({ maxThreads: cpuQuota });
  console.log(`[cpu-quota] llama.maxThreads resolved to: ${llama.maxThreads}`);

  const model = await llama.loadModel({ modelPath: config.modelPath });
  const context = await model.createContext({ contextSize: 8192, sequences: 3 });

  const sequences: LlamaContextSequence[] = [context.getSequence(), context.getSequence(), context.getSequence()];
  let nextSequenceIndex = 0;

  return {
    createChatSession(systemPrompt: string): ChatDriverSession {
      if (nextSequenceIndex >= sequences.length) {
        throw new Error("llamaCppDriver: no more sequences available (only 3 pre-allocated)");
      }
      const sequence = sequences[nextSequenceIndex++];
      return new LlamaCppChatSession(llama, sequence, systemPrompt);
    },
    async dispose() {
      await context.dispose();
      await model.dispose();
    },
  };
}
