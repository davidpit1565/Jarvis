import Anthropic from "@anthropic-ai/sdk";
import type { Brain, BrainRequest, BrainResponse } from "@/types/brain";
import type { ConversationMessage, ToolCallRequest } from "@/types/conversation";
import type { ToolDefinition } from "@/types/tools";

type ContentBlockParam =
  | Anthropic.TextBlockParam
  | Anthropic.ToolUseBlockParam
  | Anthropic.ToolResultBlockParam
  | Anthropic.ImageBlockParam;

export const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";
const DEFAULT_MAX_TOKENS = 1024;
const ANTHROPIC_API_BASE_URL = "https://api.anthropic.com";

export interface ClaudeBrainOptions {
  model?: string;
  maxTokens?: number;
  /**
   * Enables Anthropic's own server-side web_search tool — real internet
   * search that runs on Anthropic's infrastructure, billed through the
   * same API key, no separate vendor/account. Off by default: it changes
   * what JARVIS can see and costs extra per search, so it's an explicit
   * opt-in (JARVIS_WEB_SEARCH=true), not a silent default.
   */
  webSearchEnabled?: boolean;
  webSearchMaxUses?: number;
  /**
   * Enables Anthropic's own server-side web_fetch tool — lets Claude
   * actually open and read a specific URL's content (a page it found via
   * web_search, or one the user gave directly), not just see a search
   * snippet. Same account/billing as web_search, same reasoning for being
   * an explicit opt-in (JARVIS_WEB_FETCH=true).
   */
  webFetchEnabled?: boolean;
  webFetchMaxUses?: number;
  /**
   * Overrides the Anthropic API base URL — a deliberate, explicit opt-in
   * only, distinct from the SDK's own ambient ANTHROPIC_BASE_URL support
   * (see the constructor comment below for why that's never honored
   * silently). Meant for pointing JARVIS at a local Anthropic-compatible
   * gateway (e.g. a self-hosted model router) instead of Anthropic's own
   * API, for cost reasons. Unset means "talk to the real Anthropic API,"
   * always.
   */
  baseUrl?: string;
  /**
   * A cheaper/different model to retry against, once, if the primary
   * model call fails with a retryable-but-exhausted error (429 rate
   * limit, 503/529 overloaded) even after the SDK's own maxRetries. A
   * degraded reply from a fallback model beats no reply at all during a
   * provider outage or a rate-limit spike — this is a real-availability
   * tradeoff, not a cost-saving default, so it's opt-in only
   * (JARVIS_FALLBACK_MODEL unset means no fallback, ever).
   */
  fallbackModel?: string;
  /**
   * Enables Anthropic's native prompt caching (`cache_control: {type:
   * "ephemeral"}`) on the system prompt and on the last tool definition.
   * JARVIS's system prompt and tool list are large and re-sent, byte for
   * byte, on almost every single call in a conversation — caching them
   * means every call after the first one in a cache window (5 minutes)
   * only pays the steeply discounted cache-read rate for that prefix
   * instead of the full input-token price, with zero change to what
   * Claude actually sees. This is a pure cost optimization: it changes
   * nothing about behavior or correctness, so it defaults to on. Only a
   * request that ends up with neither a system prompt nor any tools has
   * nothing to mark — cache_control is simply omitted then. See
   * `estimateCostUsd`/`CostTracker`, which already read back
   * `cache_creation_input_tokens`/`cache_read_input_tokens` from every
   * response regardless of whether this is on.
   */
  promptCachingEnabled?: boolean;
}

/**
 * Talks to Anthropic's Messages API. This class only decides *what* Claude
 * wants to happen next (text and/or tool calls) — it never executes tools
 * itself. The orchestrator owns that decision.
 */
export class ClaudeBrain implements Brain {
  private client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly webSearchEnabled: boolean;
  private readonly webSearchMaxUses: number;
  private readonly webFetchEnabled: boolean;
  private readonly webFetchMaxUses: number;
  private readonly fallbackModel?: string;
  private readonly promptCachingEnabled: boolean;

  constructor(apiKey: string, options: ClaudeBrainOptions = {}) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.webSearchEnabled = options.webSearchEnabled ?? false;
    this.webSearchMaxUses = options.webSearchMaxUses ?? 5;
    this.webFetchEnabled = options.webFetchEnabled ?? false;
    this.webFetchMaxUses = options.webFetchMaxUses ?? 5;
    this.fallbackModel = options.fallbackModel;
    this.promptCachingEnabled = options.promptCachingEnabled ?? true;
    // baseURL defaults to the real Anthropic API and is pinned there
    // unless `options.baseUrl` is explicitly given: the Anthropic SDK
    // otherwise honors an ambient ANTHROPIC_BASE_URL environment variable,
    // which on a developer's machine may point at an unrelated local
    // proxy/router (e.g. a different AI tool) — JARVIS must never silently
    // pick that up. A deliberate `options.baseUrl` (from JARVIS's own
    // JARVIS_ANTHROPIC_BASE_URL config, not the ambient SDK one) is the
    // only way to point this at anything else.
    //
    // maxRetries/timeout are set explicitly rather than left at the SDK's
    // own defaults (2 retries, 10 minutes) — 4 retries gives a call on a
    // flaky connection (phone calls in particular can't just be asked to
    // "try again") more chances to recover from a transient 429/5xx before
    // giving up, and a 30s cap keeps a single stuck request from silently
    // blocking a phone call or chat turn far longer than a human would
    // ever wait. The SDK already backs off between retries and honors the
    // API's Retry-After header — there is no reason to reimplement that.
    this.client = new Anthropic({
      apiKey,
      baseURL: options.baseUrl ?? ANTHROPIC_API_BASE_URL,
      maxRetries: 4,
      timeout: 30_000,
    });
  }

  /** Exposed for testing/diagnostics — the actual API base URL this instance talks to. */
  get baseUrl(): string {
    return this.client.baseURL;
  }

  async chat(request: BrainRequest): Promise<BrainResponse> {
    const messages = toAnthropicMessages(request.messages);
    const tools = this.buildTools(request.tools);
    const system = this.buildSystem(request.context);
    if (this.promptCachingEnabled) markLastToolCacheable(tools);

    const params = {
      max_tokens: this.maxTokens,
      system,
      messages,
      tools: tools.length > 0 ? tools : undefined,
    };

    try {
      const response = await this.client.messages.create({ model: this.model, ...params });
      return fromAnthropicResponse(response);
    } catch (error) {
      if (this.fallbackModel && this.fallbackModel !== this.model && isRetryableWithFallback(error)) {
        const response = await this.client.messages.create({ model: this.fallbackModel, ...params });
        return fromAnthropicResponse(response);
      }
      throw error;
    }
  }

  private buildTools(tools: ToolDefinition[]): Anthropic.ToolUnion[] {
    return buildAnthropicTools(
      tools,
      this.webSearchEnabled,
      this.webSearchMaxUses,
      this.webFetchEnabled,
      this.webFetchMaxUses
    );
  }

  /**
   * The system prompt (JARVIS_SYSTEM_PROMPT + any per-turn context note)
   * is identical, byte for byte, across almost every call in a
   * conversation — a textbook prompt-caching candidate. When enabled,
   * it's sent as a single text block with an ephemeral cache breakpoint
   * instead of a plain string; Anthropic requires the array form to
   * attach `cache_control` at all. Disabled (or no context at all)
   * falls back to exactly the previous plain-string/undefined shape.
   */
  private buildSystem(context: string | undefined): string | Anthropic.TextBlockParam[] | undefined {
    if (!context) return undefined;
    if (!this.promptCachingEnabled) return context;
    return [{ type: "text", text: context, cache_control: { type: "ephemeral" } }];
  }
}

/**
 * Marks the last tool definition with an ephemeral cache breakpoint.
 * Anthropic's prompt cache works on a prefix: marking the last tool
 * caches every tool definition before and including it (the whole tools
 * array, since it's always sent in the same order), same idea as the
 * system-prompt breakpoint above. A no-op when there are no tools —
 * there's nothing to mark, and an empty array is never sent as `tools`
 * anyway (see `params.tools` above).
 */
export function markLastToolCacheable(tools: Anthropic.ToolUnion[]): void {
  const last = tools[tools.length - 1];
  if (last) {
    (last as { cache_control?: Anthropic.CacheControlEphemeral | null }).cache_control = { type: "ephemeral" };
  }
}

/** Exported for unit testing without a network call — pure request-shaping logic. */
export function buildAnthropicTools(
  tools: ToolDefinition[],
  webSearchEnabled: boolean,
  webSearchMaxUses: number,
  webFetchEnabled: boolean = false,
  webFetchMaxUses: number = 5
): Anthropic.ToolUnion[] {
  const result: Anthropic.ToolUnion[] = toAnthropicTools(tools);
  if (webSearchEnabled) {
    // The "20250305" (basic) variant works with any current model, unlike
    // the newer dynamic-filtering variant which requires a more recent
    // model than JARVIS defaults to.
    result.push({ type: "web_search_20250305", name: "web_search", max_uses: webSearchMaxUses });
  }
  if (webFetchEnabled) {
    // Same reasoning as web_search above: the "20250910" (basic) variant
    // works with any current model.
    result.push({ type: "web_fetch_20250910", name: "web_fetch", max_uses: webFetchMaxUses });
  }
  return result;
}

/**
 * True only for the specific errors a fallback model can actually help
 * with — the primary model itself being rate-limited or overloaded, after
 * the SDK's own maxRetries gave up. Anything else (a bad request, an auth
 * failure, a genuine tool-input problem) would fail identically on the
 * fallback model too, so it's not worth the extra latency of trying.
 */
export function isRetryableWithFallback(error: unknown): boolean {
  return error instanceof Anthropic.APIError && (error.status === 429 || error.status === 503 || error.status === 529);
}

function toAnthropicTools(tools: ToolDefinition[]): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema as Anthropic.Tool.InputSchema,
  }));
}

export function toAnthropicMessages(messages: ConversationMessage[]): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      // Plain string content for the common (text-only) case, matching
      // every other channel's existing behavior exactly. Only a turn
      // with real attached images pays for the array-of-blocks form —
      // images first, text last, matching Anthropic's own documented
      // ordering recommendation for image + question turns.
      if (message.images?.length) {
        const content: ContentBlockParam[] = message.images.map((image) => ({
          type: "image",
          source: { type: "base64", media_type: image.mediaType, data: image.data },
        }));
        if (message.content) content.push({ type: "text", text: message.content });
        result.push({ role: "user", content });
      } else {
        result.push({ role: "user", content: message.content });
      }
      continue;
    }

    if (message.role === "assistant") {
      const content: ContentBlockParam[] = [];
      if (message.content) {
        content.push({ type: "text", text: message.content });
      }
      for (const call of message.toolCalls ?? []) {
        content.push({ type: "tool_use", id: call.id, name: call.toolName, input: call.input });
      }
      result.push({ role: "assistant", content });
      continue;
    }

    // Tool results are sent back to Claude as a user turn containing a
    // tool_result block, per the Anthropic tool-use protocol.
    result.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: message.toolCallId,
          content: message.content,
        },
      ],
    });
  }

  return result;
}

/** Exported for unit testing without a network call — pure response-shaping logic. */
export function fromAnthropicResponse(response: Anthropic.Message): BrainResponse {
  let text = "";
  const toolCalls: ToolCallRequest[] = [];
  const serverToolUses: string[] = [];

  for (const block of response.content) {
    if (block.type === "text") {
      text += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        toolName: block.name,
        input: block.input as Record<string, unknown>,
      });
    } else if (block.type === "server_tool_use") {
      serverToolUses.push(block.name);
    }
  }

  return {
    text,
    toolCalls,
    stopReason: response.stop_reason ?? "unknown",
    serverToolUses: serverToolUses.length > 0 ? serverToolUses : undefined,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
    },
  };
}
