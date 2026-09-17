import type { AssistantMessage, ConversationMessage, ToolResultMessage } from "@/types/conversation";
import type { EventBus } from "@/core/events/EventBus";

/**
 * Holds the in-progress conversation for a single session. This is
 * short-lived turn state, distinct from the long-term MemoryStore.
 */
export class ConversationManager {
  private messages: ConversationMessage[] = [];

  constructor(private readonly eventBus?: EventBus) {}

  addUserMessage(content: string): void {
    const message: ConversationMessage = { role: "user", content };
    this.messages.push(message);
    this.eventBus?.emit("conversation.message", { message });
  }

  addAssistantMessage(content: string, toolCalls?: AssistantMessage["toolCalls"]): void {
    const message: ConversationMessage = { role: "assistant", content, toolCalls };
    this.messages.push(message);
    this.eventBus?.emit("conversation.message", { message });
  }

  addToolResult(toolCallId: string, toolName: string, content: string): void {
    const message: ToolResultMessage = { role: "tool", toolCallId, toolName, content };
    this.messages.push(message);
    this.eventBus?.emit("conversation.message", { message });
  }

  getMessages(): ConversationMessage[] {
    return [...this.messages];
  }

  clear(): void {
    this.messages = [];
  }
}
