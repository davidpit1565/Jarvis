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
}

/**
 * Provider-agnostic interface so the underlying LLM (Claude today) can be
 * swapped without touching the orchestrator or conversation manager.
 */
export interface Brain {
  chat(request: BrainRequest): Promise<BrainResponse>;
}
