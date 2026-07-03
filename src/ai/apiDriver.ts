import type { ChatDriverSession, JsonSchema, LlmDriver, ToolDef } from "./llmDriver.js";

/**
 * LlmDriver implementation for any OpenAI-compatible chat completions API —
 * Hugging Face Inference Providers (https://router.huggingface.co/v1) and
 * OpenRouter (https://openrouter.ai/api/v1) both implement this same
 * request/response shape, so one client serves both (and any other
 * OpenAI-compatible provider) via config alone, no provider-specific code.
 *
 * Unlike node-llama-cpp's LlamaChatSession, a raw chat completions API does
 * not run the tool-calling loop for you - it returns one exchange at a
 * time, and the caller decides whether to execute a requested tool call
 * and continue. prompt() below reimplements that loop manually so ai/'s
 * turn logic sees the same "give me tools, get back final text" contract
 * as the node-llama-cpp backend.
 */
export interface ApiBackendConfig {
  /** e.g. "https://router.huggingface.co/v1" or "https://openrouter.ai/api/v1" - no trailing slash. */
  baseURL: string;
  apiKey: string;
  model: string;
  /**
   * Safety cap on tool-calling round trips within a single prompt() call.
   * node-llama-cpp enforces its own internal cap; since we own this loop
   * for the API backend, we own the cap too. Defaults to 8.
   */
  maxToolRounds?: number;
}

interface OpenAiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
}

interface ChatCompletionResult {
  message: OpenAiMessage;
  finishReason: string;
}

async function postChatCompletion(
  config: ApiBackendConfig,
  body: Record<string, unknown>,
): Promise<ChatCompletionResult> {
  const response = await fetch(`${config.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({ model: config.model, ...body }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`API request to ${config.baseURL} failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: OpenAiMessage; finish_reason: string }>;
  };
  const choice = data.choices[0];
  if (!choice) {
    throw new Error("API response had no choices");
  }
  return { message: choice.message, finishReason: choice.finish_reason };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/**
 * Replaces a stale tool-role message's content once its round has finished
 * - the model already used the real result to produce its next message;
 * keeping the full JSON blob around forever only grows every later
 * request's payload for no ongoing benefit (get_scope's result in
 * particular is one of the largest, most frequently-called results, and
 * a turn or two later it no longer reflects current state anyway).
 */
const COMPACTED_TOOL_RESULT = '{"note":"omitted - superseded by a later tool call"}';

class ApiChatSession implements ChatDriverSession {
  private messages: OpenAiMessage[];

  constructor(
    private readonly config: ApiBackendConfig,
    systemPrompt: string,
  ) {
    this.messages = [{ role: "system", content: systemPrompt }];
  }

  async prompt(input: string, tools?: ToolDef[]): Promise<string> {
    // Every tool-role message already in history belongs to a now-finished
    // round (this turn's own tool calls haven't been pushed yet) - compact
    // them before adding anything new. Correction-retry calls (no `tools`,
    // see ai/index.ts) re-embed the relevant result directly in their
    // prompt text, so nothing is lost by compacting here unconditionally.
    for (const message of this.messages) {
      if (message.role === "tool" && message.content !== COMPACTED_TOOL_RESULT) {
        message.content = COMPACTED_TOOL_RESULT;
      }
    }

    this.messages.push({ role: "user", content: input });

    const toolsByName = new Map((tools ?? []).map((tool) => [tool.name, tool]));
    const openAiTools =
      tools && tools.length > 0
        ? tools.map((tool) => ({
            type: "function" as const,
            function: { name: tool.name, description: tool.description, parameters: tool.parameters },
          }))
        : undefined;

    const maxRounds = this.config.maxToolRounds ?? 8;
    for (let round = 0; round < maxRounds; round++) {
      const { message } = await postChatCompletion(this.config, {
        messages: this.messages,
        ...(openAiTools ? { tools: openAiTools } : {}),
      });
      this.messages.push(message);

      if (!message.tool_calls || message.tool_calls.length === 0) {
        return message.content ?? "";
      }

      for (const toolCall of message.tool_calls) {
        const tool = toolsByName.get(toolCall.function.name);
        const result = tool
          ? await tool.handler(safeJsonParse(toolCall.function.arguments))
          : { error: `Unknown tool "${toolCall.function.name}"` };
        this.messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        });
      }
    }

    throw new Error(`API chat session exceeded ${maxRounds} tool-calling rounds without a final text response`);
  }

  async promptForJson<T>(input: string, schema: JsonSchema): Promise<T> {
    const systemMessage = this.messages[0]!;

    try {
      const { message } = await postChatCompletion(this.config, {
        messages: [systemMessage, { role: "user", content: input }],
        response_format: { type: "json_schema", json_schema: { name: "response", schema, strict: true } },
      });
      return JSON.parse(message.content ?? "{}") as T;
    } catch {
      // Not every model/provider honors strict json_schema mode - "flexible
      // for every model" means we can't assume structured-output support is
      // universal. Fall back to a looser json_object request with the
      // schema described directly in the prompt text.
      const { message } = await postChatCompletion(this.config, {
        messages: [
          systemMessage,
          {
            role: "user",
            content:
              `${input}\n\nRespond with ONLY a JSON object matching this schema, ` +
              `no other text:\n${JSON.stringify(schema)}`,
          },
        ],
        response_format: { type: "json_object" },
      });
      return JSON.parse(message.content ?? "{}") as T;
    }
  }

  resetHistory(): void {
    this.messages = [this.messages[0]!];
  }

  compactToSummary(summaryText: string): void {
    const systemMessage = this.messages[0]!;
    this.messages = [systemMessage, { role: "user", content: `[Recap of earlier turns]: ${summaryText}` }];
  }
}

export function createApiDriver(config: ApiBackendConfig): LlmDriver {
  return {
    createChatSession(systemPrompt: string): ChatDriverSession {
      return new ApiChatSession(config, systemPrompt);
    },
    async dispose() {
      // No persistent resources to release for a stateless HTTP client.
    },
  };
}
