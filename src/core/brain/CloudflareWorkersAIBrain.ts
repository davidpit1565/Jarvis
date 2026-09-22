import type { Brain, BrainRequest, BrainResponse } from "@/types/brain";
import type { ConversationMessage, ToolCallRequest } from "@/types/conversation";
import type { ToolDefinition } from "@/types/tools";
import { fetchWithRetry } from "@/core/net/fetchWithRetry";

const DEFAULT_MAX_TOKENS = 1024;
const CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com/client/v4";
const MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 1_000;
/**
 * Cloudflare's own default `fetch()` timeout assumption (10s, matching
 * `fetchWithRetry`'s own default) is fine here — this is a real hosted
 * API on Cloudflare's own edge network, not a user-run local server the
 * way `OllamaBrain` talks to, so there's no reason to override it the way
 * that class does.
 */

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
 * Talks to Cloudflare Workers AI's OpenAI-compatible chat completions
 * endpoint (`POST /client/v4/accounts/{account_id}/ai/v1/chat/completions`,
 * `Authorization: Bearer <api_token>` — verified against Cloudflare's own
 * current developer docs, not guessed) — a real, genuinely-free option
 * alongside `GroqBrain`/`OpenRouterBrain`/`OllamaBrain`.
 *
 * Cloudflare Workers AI's free tier (verified against
 * https://developers.cloudflare.com/workers-ai/platform/pricing/): 10,000
 * "Neurons" (its own compute-unit currency) per account per day, resetting
 * daily at 00:00 UTC, no credit card required. Critically — the property
 * that makes it safe to treat as genuinely free the same way Groq/
 * OpenRouter/Ollama are (see `CostTracker.KNOWN_FREE_PROVIDERS`) — once the
 * daily allocation is exhausted, Cloudflare's own docs say further calls
 * simply "fail with an error"; it does NOT silently start billing a card on
 * file. (A separate opt-in "Workers Paid" plan exists that bills overage,
 * but that's an explicit account-level upgrade the user has to choose, not
 * something this provider triggers on its own.)
 *
 * Unlike `OllamaBrain` (no config required at all — it's software the user
 * already runs locally), this is a real hosted Cloudflare account: both an
 * account id and an API token are required, with no default, the same
 * "JARVIS can't guess it, so don't try" reasoning `OllamaBrain` applies to
 * its own required `model` param. Model id is likewise always
 * user-supplied — Cloudflare hosts 50+ models (Llama, Mistral, Gemma,
 * DeepSeek, Qwen, and more) and there's no single sensible default JARVIS
 * could pick correctly for everyone.
 *
 * Message/tool-call translation is the exact same OpenAI-compatible shape
 * `GroqBrain`/`OpenRouterBrain`/`OllamaBrain` already implement — reused
 * verbatim (same `toOpenAIMessages`/`toOpenAITools`/`fromOpenAIResponse`
 * shapes, duplicated per-file the way those three already are, rather than
 * factored out — this file changes nothing about that existing pattern).
 */
export class CloudflareWorkersAIBrain implements Brain {
  private readonly accountId: string;
  private readonly apiToken: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly baseUrl: string;
  private readonly retryDelayMs: number;

  constructor(
    accountId: string | undefined,
    apiToken: string | undefined,
    options: { model?: string; maxTokens?: number; baseUrl?: string; retryDelayMs?: number } = {}
  ) {
    if (!accountId || !accountId.trim()) {
      throw new Error(
        "CloudflareWorkersAIBrain requires a Cloudflare account id — set CLOUDFLARE_ACCOUNT_ID to the account id " +
          "shown on any zone/account overview page in the Cloudflare dashboard."
      );
    }
    if (!apiToken || !apiToken.trim()) {
      throw new Error(
        "CloudflareWorkersAIBrain requires a Cloudflare API token — set CLOUDFLARE_API_TOKEN to a token created " +
          'under My Profile > API Tokens with "Workers AI" read/edit permission.'
      );
    }
    if (!options.model || !options.model.trim()) {
      throw new Error(
        "CloudflareWorkersAIBrain requires a model id — set CLOUDFLARE_MODEL to one of Cloudflare Workers AI's " +
          'hosted models (e.g. "@cf/meta/llama-3.3-70b-instruct-fp8-fast"; see ' +
          "https://developers.cloudflare.com/workers-ai/models/ for the full catalog). Unlike a single-model " +
          "provider, Cloudflare hosts 50+ models with no single sensible default JARVIS could guess."
      );
    }
    this.accountId = accountId;
    this.apiToken = apiToken;
    this.model = options.model;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.baseUrl = options.baseUrl ?? CLOUDFLARE_API_BASE_URL;
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

    const url = `${this.baseUrl}/accounts/${this.accountId}/ai/v1/chat/completions`;

    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let response: Response;
      try {
        response = await fetchWithRetry(
          url,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${this.apiToken}`, "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
          // fetchWithRetry already retries network failures/5xx/429
          // internally with its own bounded attempts; the outer loop here
          // only exists to mirror GroqBrain/OpenRouterBrain/OllamaBrain's
          // own 429/503-retry shape. maxAttempts: 1 keeps this class in
          // sole control of its own retry/backoff cadence.
          { maxAttempts: 1 }
        );
      } catch (error) {
        // Connection failure/timeout — surfaced as a clear, actionable
        // error rather than an uncaught exception, same reasoning as
        // OllamaBrain's own doc comment on this.
        throw new Error(
          `Could not reach Cloudflare Workers AI (account ${this.accountId}) — check that CLOUDFLARE_ACCOUNT_ID and ` +
            `CLOUDFLARE_API_TOKEN are correct and the token has "Workers AI" permission. ` +
            `(${error instanceof Error ? error.message : String(error)})`
        );
      }

      if (response.ok) {
        return fromOpenAIResponse((await response.json()) as OpenAIChatCompletionResponse);
      }

      // 429 covers both a normal rate limit AND Cloudflare's daily free
      // "Neurons" allocation being exhausted (its own docs: exceeding the
      // limit makes "further operations fail with an error" — modeled the
      // same way a rate limit is, since Cloudflare doesn't expose a
      // separate status code for "quota exhausted for today"). 503 is a
      // transient overload. Neither is retried on the LAST attempt, since a
      // daily quota exhaustion won't clear up within a few backoff delays.
      if ((response.status === 429 || response.status === 503) && attempt < MAX_RETRIES) {
        lastError = new Error(`Cloudflare Workers AI chat completion failed (${response.status})`);
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * (attempt + 1)));
        continue;
      }

      const detail = await response.text().catch(() => "");
      if (response.status === 429) {
        throw new Error(
          `Cloudflare Workers AI chat completion failed (429) — this is either a normal rate limit or, more likely, ` +
            `today's free 10,000-Neuron daily allocation is exhausted (resets at 00:00 UTC). Detail: ${detail}`
        );
      }
      if (response.status === 401 || response.status === 403) {
        throw new Error(
          `Cloudflare Workers AI chat completion failed (${response.status}) — check that CLOUDFLARE_API_TOKEN is ` +
            `valid and has "Workers AI" read/edit permission, and that CLOUDFLARE_ACCOUNT_ID matches the account ` +
            `that token belongs to. Detail: ${detail}`
        );
      }
      throw new Error(`Cloudflare Workers AI chat completion failed (${response.status}): ${detail}`);
    }

    throw lastError ?? new Error("Cloudflare Workers AI chat completion failed after retries");
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
  // TypeError here — same reasoning as GroqBrain/OpenRouterBrain/
  // OllamaBrain's own fromOpenAIResponse.
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
          // Cloudflare Workers AI's OpenAI-compat layer doesn't do
          // Anthropic-style prompt caching — always 0, honestly, rather
          // than omitting the fields.
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        }
      : undefined,
    model: response.model,
  };
}
