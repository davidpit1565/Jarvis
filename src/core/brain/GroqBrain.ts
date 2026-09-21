import type { Brain, BrainRequest, BrainResponse } from "@/types/brain";
import type { ConversationMessage, ToolCallRequest } from "@/types/conversation";
import type { ToolDefinition } from "@/types/tools";

export const DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile";
const DEFAULT_MAX_TOKENS = 1024;
const GROQ_API_BASE_URL = "https://api.groq.com/openai/v1";
const MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 1_000;

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAIContentBlock[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

type OpenAIContentBlock =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/**
 * Talks to Groq's OpenAI-compatible chat completions endpoint — a real
 * $0 alternative to ClaudeBrain, added on explicit request. Groq's free
 * tier (verified during development: 14,400 requests/day on
 * llama-3.3-70b-versatile-class models, no credit card, real tool-calling
 * support) is a genuine free option, not a trial that turns into billing.
 *
 * Same `Brain` interface as ClaudeBrain — the whole reason that interface
 * is provider-agnostic (see its own doc comment) — so nothing in
 * Orchestrator/ConversationManager changes to use this instead. See
 * README's "Free ($0) brain: Groq" section for the honest quality
 * tradeoff this represents (JARVIS's tool-calling reliability and
 * Hebrew/English handling are tuned against real Claude models, not this
 * one) — opt-in only (JARVIS_BRAIN_PROVIDER=groq), never the default.
 */
export class GroqBrain implements Brain {
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly baseUrl: string;
  private readonly retryDelayMs: number;

  constructor(
    private readonly apiKey: string,
    options: { model?: string; maxTokens?: number; baseUrl?: string; retryDelayMs?: number } = {}
  ) {
    this.model = options.model ?? DEFAULT_GROQ_MODEL;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.baseUrl = options.baseUrl ?? GROQ_API_BASE_URL;
    // Test-only override — production always uses the real backoff delay.
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  }

  async chat(request: BrainRequest): Promise<BrainResponse> {
    const messages = toOpenAIMessages(request.messages, request.context);
    const tools = toOpenAITools(request.tools);

    const body = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages,
      tools: tools.length > 0 ? tools : undefined,
    };

    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (response.ok) {
        return fromOpenAIResponse((await response.json()) as OpenAIChatCompletionResponse);
      }

      // Only 429 (free-tier rate limit) and 503 (transient overload) are
      // worth retrying — a 401/400 would fail identically every time.
      if ((response.status === 429 || response.status === 503) && attempt < MAX_RETRIES) {
        lastError = new Error(`Groq chat completion failed (${response.status})`);
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * (attempt + 1)));
        continue;
      }

      const detail = await response.text().catch(() => "");
      throw new Error(`Groq chat completion failed (${response.status}): ${detail}`);
    }

    throw lastError ?? new Error("Groq chat completion failed after retries");
  }
}

function toOpenAIMessages(messages: ConversationMessage[], systemContext?: string): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];
  if (systemContext) {
    result.push({ role: "system", content: systemContext });
  }

  for (const message of messages) {
    if (message.role === "user") {
      if (message.images?.length) {
        const content: OpenAIContentBlock[] = message.images.map((image) => ({
          type: "image_url",
          image_url: { url: `data:${image.mediaType};base64,${image.data}` },
        }));
        if (message.content) content.push({ type: "text", text: message.content });
        result.push({ role: "user", content });
      } else {
        result.push({ role: "user", content: message.content });
      }
      continue;
    }

    if (message.role === "assistant") {
      const toolCalls = (message.toolCalls ?? []).map((call) => ({
        id: call.id,
        type: "function" as const,
        function: { name: call.toolName, arguments: JSON.stringify(call.input) },
      }));
      result.push({
        role: "assistant",
        content: message.content || null,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      });
      continue;
    }

    // Tool result — OpenAI's shape is its own top-level "tool" role
    // message (tool_call_id + content), not nested inside a user turn
    // like Anthropic's tool_result content block.
    result.push({ role: "tool", tool_call_id: message.toolCallId, content: message.content });
  }

  return result;
}

function toOpenAITools(tools: ToolDefinition[]) {
  return tools.map((tool) => ({
    type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
  }));
}

interface OpenAIChatCompletionResponse {
  choices: Array<{
    message: {
      content: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
  /** The model that actually served this call, per the OpenAI-compatible response shape — echoed back for CostTracker's per-model ledger. */
  model?: string;
}

/** Exported for unit testing without a network call — pure response-shaping logic. */
export function fromOpenAIResponse(response: OpenAIChatCompletionResponse): BrainResponse {
  // Defensive: a malformed/error-shaped body from Groq (or any other
  // OpenAI-compatible endpoint someone points this at) with no `choices`
  // array at all shouldn't throw an uncaught TypeError here — every
  // caller already wraps handleUserMessage in try/catch, but failing
  // gracefully at the source is still better than relying on that alone.
  const choice = Array.isArray(response.choices) ? response.choices[0] : undefined;
  const text = choice?.message.content ?? "";

  const toolCalls: ToolCallRequest[] = (choice?.message.tool_calls ?? []).map((call) => {
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(call.function.arguments);
    } catch {
      // A model that returns malformed JSON arguments shouldn't crash the
      // whole turn — the tool itself will report an input-validation
      // failure back to the model instead, the same as any other bad input.
    }
    return { id: call.id, toolName: call.function.name, input };
  });

  return {
    text,
    toolCalls,
    stopReason: choice?.finish_reason ?? "unknown",
    usage: response.usage
      ? {
          inputTokens: response.usage.prompt_tokens,
          outputTokens: response.usage.completion_tokens,
          // Groq's free tier doesn't do Anthropic-style prompt caching —
          // always 0, honestly, rather than omitting the fields.
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        }
      : undefined,
    model: response.model,
  };
}
