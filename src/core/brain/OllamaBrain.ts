import type { Brain, BrainRequest, BrainResponse } from "@/types/brain";
import type { ConversationMessage, ToolCallRequest } from "@/types/conversation";
import type { ToolDefinition } from "@/types/tools";
import { fetchWithRetry } from "@/core/net/fetchWithRetry";

export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
const DEFAULT_MAX_TOKENS = 1024;
/**
 * Local inference on modest consumer hardware (a laptop CPU, an older
 * GPU) can genuinely take tens of seconds per response — nothing like a
 * hosted API's latency. `fetchWithRetry`'s own default (10s, see its doc
 * comment) is tuned for a well-provisioned remote service and would abort
 * a perfectly healthy local Ollama server mid-generation. 30s is a 3x
 * override — generous, but still finite, since a genuinely unreachable
 * server (Ollama not running, or a `localhost` that isn't actually the
 * same machine — see this class's own doc comment) should still fail in
 * bounded time rather than hang a tool call forever.
 */
const DEFAULT_TIMEOUT_MS = 30_000;
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
 * Talks to a user-run Ollama server's (https://ollama.com) OpenAI-compatible
 * `chat/completions` endpoint — the ultimate $0, unlimited AI provider,
 * because there's no vendor at all: the model runs on hardware the user
 * already owns, under software they installed and start themselves
 * (`ollama serve`, after `ollama pull <model>`). Message/tool-call
 * translation is the exact same OpenAI-compatible shape `GroqBrain`/
 * `OpenRouterBrain` already implement — reused verbatim (same
 * `toOpenAIMessages`/`toOpenAITools`/`fromOpenAIResponse` shapes, just
 * duplicated per-file the way those two already are, rather than factored
 * out — this file changes nothing about that existing pattern) — the only
 * real differences from those two are:
 *
 * - No API key is ever required. Ollama's default local setup has no
 *   auth at all, so `apiKey` is optional here (unlike `GroqBrain`'s and
 *   `OpenRouterBrain`'s required constructor param) and no
 *   `Authorization` header is sent unless one is explicitly configured
 *   (e.g. the user put Ollama behind a reverse proxy that does require a
 *   bearer token). Never treat a missing key as a reason to refuse to
 *   construct.
 * - No `:free`-suffix-style gate (`OpenRouterBrain`'s
 *   `OpenRouterPaidModelError` pattern). There is no paid tier concept
 *   for a locally-run model at all — whatever the user pulled is $0 by
 *   construction, so `AIProviderRegistry.register("ollama", ..., "free")`
 *   and `CostTracker`'s `KNOWN_FREE_PROVIDERS` need no per-model check
 *   the way OpenRouter's mixed marketplace does.
 * - A much longer default request timeout (`DEFAULT_TIMEOUT_MS`, see its
 *   own doc comment) via `fetchWithRetry` instead of a bare `fetch()` —
 *   local inference on modest hardware is genuinely slower than a hosted
 *   API, and the other two Brains' 10s-class assumptions don't hold here.
 *
 * IMPORTANT — this is NOT a hosted service, and "it just works" is a
 * false promise for most real deployments: if JARVIS's backend runs
 * somewhere other than the machine (or LAN) actually running
 * `ollama serve` — e.g. JARVIS on Fly.io and Ollama on the user's Mac at
 * home — `http://localhost:11434` from Fly.io's perspective is Fly.io's
 * own container, not the user's Mac, and every call here will fail with
 * a connection error. This only works out of the box when JARVIS and
 * Ollama run on the same machine or the same local network. Bridging a
 * cloud deployment to a home machine (e.g. via Tailscale or ngrok, so
 * `OLLAMA_BASE_URL` points at a reachable tunnel/VPN address instead of
 * `localhost`) is the user's own setup responsibility — see README's
 * Ollama section — not something this class attempts to solve.
 */
export class OllamaBrain implements Brain {
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly baseUrl: string;
  private readonly retryDelayMs: number;
  private readonly timeoutMs: number;

  constructor(
    private readonly apiKey?: string,
    options: { model?: string; maxTokens?: number; baseUrl?: string; retryDelayMs?: number; timeoutMs?: number } = {}
  ) {
    if (!options.model || !options.model.trim()) {
      throw new Error(
        "OllamaBrain requires a model id — set OLLAMA_MODEL to a model you've already pulled locally " +
          '(e.g. "ollama pull qwen2.5" then OLLAMA_MODEL=qwen2.5). Unlike a hosted provider, there is no ' +
          "sensible default: JARVIS can't guess which model you've actually pulled."
      );
    }
    this.model = options.model;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.baseUrl = options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL;
    // Test-only override — production always uses the real backoff delay.
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let response: Response;
      try {
        response = await fetchWithRetry(
          `${this.baseUrl}/v1/chat/completions`,
          { method: "POST", headers, body: JSON.stringify(body) },
          // fetchWithRetry already retries network failures/5xx/429
          // internally with its own bounded attempts; the outer loop here
          // only exists to mirror GroqBrain/OpenRouterBrain's own
          // 429/503-retry shape for a non-retryable-by-fetchWithRetry
          // case. maxAttempts: 1 keeps this class in sole control of its
          // own retry/backoff cadence, same total behavior as those two.
          { timeoutMs: this.timeoutMs, maxAttempts: 1 }
        );
      } catch (error) {
        // Connection refused / DNS failure / timeout — the single most
        // likely real-world failure mode for this provider specifically
        // (the user hasn't started `ollama serve`, or JARVIS's backend
        // simply can't reach wherever it's running — see this class's own
        // doc comment on the localhost/network-reachability caveat).
        // Surfaced as a clear, actionable error rather than an uncaught
        // exception or a generic network-error message.
        throw new Error(
          `Could not reach the Ollama server at ${this.baseUrl} — is "ollama serve" running, and is it reachable ` +
            `from wherever JARVIS's backend is deployed (localhost only works when they're on the same machine/network; ` +
            `see README's Ollama section)? (${error instanceof Error ? error.message : String(error)})`
        );
      }

      if (response.ok) {
        return fromOpenAIResponse((await response.json()) as OpenAIChatCompletionResponse);
      }

      // Only 429 (unlikely locally, but a reverse-proxied Ollama might
      // rate-limit) and 503 (transient overload, e.g. the model is still
      // loading into memory) are worth retrying — a 401/400 would fail
      // identically every time.
      if ((response.status === 429 || response.status === 503) && attempt < MAX_RETRIES) {
        lastError = new Error(`Ollama chat completion failed (${response.status})`);
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * (attempt + 1)));
        continue;
      }

      const detail = await response.text().catch(() => "");
      throw new Error(`Ollama chat completion failed (${response.status}): ${detail}`);
    }

    throw lastError ?? new Error("Ollama chat completion failed after retries");
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
  // TypeError here — same reasoning as GroqBrain/OpenRouterBrain's own
  // fromOpenAIResponse.
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
          // Ollama's OpenAI-compat layer doesn't do Anthropic-style prompt
          // caching — always 0, honestly, rather than omitting the fields.
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        }
      : undefined,
    model: response.model,
  };
}
