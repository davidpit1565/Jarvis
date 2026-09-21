import type { Brain, BrainRequest, BrainResponse } from "@/types/brain";
import type { ConversationMessage, ToolCallRequest } from "@/types/conversation";
import type { ToolDefinition } from "@/types/tools";

export const DEFAULT_OPENROUTER_MODEL = "meta-llama/llama-3.3-70b-instruct:free";
const DEFAULT_MAX_TOKENS = 1024;
const OPENROUTER_API_BASE_URL = "https://openrouter.ai/api/v1";
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

type OpenAIContentBlock = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

/**
 * Thrown at construction time when the configured model doesn't carry
 * OpenRouter's own `:free` suffix — the one machine-checkable signal
 * OpenRouter gives that a model is genuinely $0. See the class doc
 * comment below for why this is enforced unconditionally, not just under
 * `ZERO_COST_MODE`.
 */
export class OpenRouterPaidModelError extends Error {}

/**
 * Talks to OpenRouter's OpenAI-compatible chat completions endpoint,
 * restricted to OpenRouter's free-tier ("`:free`"-suffixed) models only.
 *
 * OpenRouter itself is a mixed marketplace — most of its models are
 * paid, billed per-token straight through to a card on the OpenRouter
 * account, at rates this codebase has no pricing table for (unlike
 * ClaudeBrain's `estimateCostUsd`/`CostTracker` path). Rather than teach
 * `AIProviderRegistry`/`AIRouter` to track a *per-model* cost tier for
 * one provider when every other provider is priced per-call
 * (`AIProviderRegistry.register(name, brain, costTier)` is one cost tier
 * per provider, registered once at startup — see its own doc comment),
 * this class instead makes the provider itself always-free: it refuses,
 * at construction time, to be pointed at anything but a `:free` model.
 * That's a hard, load-bearing check, not a `ZERO_COST_MODE`-only one —
 * "OpenRouter is a free-tier-capable provider option" (the roadmap item
 * this exists for) means exactly that: this provider is never wired up
 * as anything else, so `AIProviderRegistry.register("openrouter", ...,
 * "free")` is always honest, and `ZERO_COST_MODE`/budget-cap logic in
 * `AIRouter` needs no special case for it at all — it's just another
 * free provider next to Groq.
 *
 * If real OpenRouter paid-model routing is ever wanted, that's a
 * separate, larger piece of work (per-model pricing table, `CostTracker`
 * support for a provider with more than one cost tier) — not something
 * to bolt onto this class.
 */
export class OpenRouterBrain implements Brain {
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly baseUrl: string;
  private readonly retryDelayMs: number;

  constructor(
    private readonly apiKey: string,
    options: { model?: string; maxTokens?: number; baseUrl?: string; retryDelayMs?: number } = {}
  ) {
    this.model = options.model ?? DEFAULT_OPENROUTER_MODEL;
    if (!this.model.endsWith(":free")) {
      throw new OpenRouterPaidModelError(
        `OpenRouterBrain only ever calls OpenRouter's free-tier models — "${this.model}" doesn't carry the ":free" ` +
          `suffix, so it's refused rather than risk silently billing a paid OpenRouter model. Set ` +
          `JARVIS_OPENROUTER_MODEL to a ":free"-suffixed model id (default: "${DEFAULT_OPENROUTER_MODEL}").`
      );
    }
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.baseUrl = options.baseUrl ?? OPENROUTER_API_BASE_URL;
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
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          // OpenRouter's documented (optional but recommended) attribution
          // headers — identifies JARVIS on OpenRouter's own dashboards,
          // never sent anywhere else and never contains the API key itself.
          "HTTP-Referer": "https://github.com/davidpit1565/Jarvis",
          "X-Title": "JARVIS",
        },
        body: JSON.stringify(body),
      });

      if (response.ok) {
        return fromOpenAIResponse((await response.json()) as OpenAIChatCompletionResponse);
      }

      // Only 429 (rate limit) and 503 (transient overload) are worth
      // retrying — a 401/400 would fail identically every time.
      if ((response.status === 429 || response.status === 503) && attempt < MAX_RETRIES) {
        lastError = new Error(`OpenRouter chat completion failed (${response.status})`);
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * (attempt + 1)));
        continue;
      }

      const detail = await response.text().catch(() => "");
      throw new Error(`OpenRouter chat completion failed (${response.status}): ${detail}`);
    }

    throw lastError ?? new Error("OpenRouter chat completion failed after retries");
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
  // Defensive: a malformed/error-shaped body shouldn't throw an uncaught
  // TypeError here — same reasoning as GroqBrain.fromOpenAIResponse.
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
          // OpenRouter's free-tier models don't do Anthropic-style prompt
          // caching — always 0, honestly, rather than omitting the fields.
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        }
      : undefined,
    model: response.model,
  };
}
