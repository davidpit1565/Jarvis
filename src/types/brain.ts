import type { ConversationMessage, ToolCallRequest } from "./conversation";
import type { ToolDefinition } from "./tools";

export interface BrainRequest {
  messages: ConversationMessage[];
  tools: ToolDefinition[];
  /** Extra context injected ahead of the conversation, e.g. relevant memory. */
  context?: string;
  /**
   * Scopes this call to one "run" — one `Orchestrator.handleUserMessage`
   * turn, or one `AgentCore` task — for AIRouter's per-run cost ceiling
   * (`maxCostPerRunUsd`, see `AIRouter`'s own doc comment) and for
   * `AIRouter.chatWithEscalation`'s "which provider actually served this
   * call" bookkeeping. Omitted means the call isn't scoped to any run: no
   * per-run ceiling applies to it, same as today's behavior.
   */
  runId?: string;
  /**
   * Coarse label for what kind of work this call serves — e.g. "chat"
   * (Orchestrator.handleUserMessage), "agent-plan"/"agent-verify"
   * (BrainAgentPlanner). Purely descriptive: it drives no routing
   * decision, it only tags the resulting `CostTracker` record so the
   * cost ledger can be broken down by task type. Omitted means
   * "unlabeled" — the record is still written, just without this
   * dimension.
   */
  taskType?: string;
}

export interface BrainResponse {
  /** Plain text portion of Claude's reply, if any. */
  text: string;
  toolCalls: ToolCallRequest[];
  /** Raw stop reason from the provider, kept opaque to callers. */
  stopReason: string;
  /**
   * Names of any provider-hosted server tools invoked this turn (e.g.
   * "web_search") — these run entirely on the provider's infrastructure,
   * never through the Orchestrator's tool-execution loop, so this is the
   * only signal callers get that one fired.
   */
  serverToolUses?: string[];
  /** Token accounting for this call, when the provider reports it — the basis for real cost tracking. */
  usage?: TokenUsage;
  /** The exact model name that actually served this call, when the provider's response reports it (e.g. Anthropic's `response.model`). Undefined for a provider/mock that doesn't echo it back. */
  model?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens written to the prompt cache this call (billed at a premium over a normal input token). */
  cacheCreationInputTokens: number;
  /** Tokens read from the prompt cache this call (billed at a steep discount vs. a normal input token). */
  cacheReadInputTokens: number;
}

/**
 * Provider-agnostic interface so the underlying LLM (Claude today) can be
 * swapped without touching the orchestrator or conversation manager.
 */
export interface Brain {
  chat(request: BrainRequest): Promise<BrainResponse>;
}
