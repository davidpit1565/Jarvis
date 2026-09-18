import type { ConversationMessage, ToolCallRequest } from "./conversation";
import type { ToolDefinition } from "./tools";

export interface BrainRequest {
  messages: ConversationMessage[];
  tools: ToolDefinition[];
  /** Extra context injected ahead of the conversation, e.g. relevant memory. */
  context?: string;
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
}

/**
 * Provider-agnostic interface so the underlying LLM (Claude today) can be
 * swapped without touching the orchestrator or conversation manager.
 */
export interface Brain {
  chat(request: BrainRequest): Promise<BrainResponse>;
}
