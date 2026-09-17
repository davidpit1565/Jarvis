export type ConversationRole = "user" | "assistant" | "tool";

export interface ToolCallRequest {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface UserMessage {
  role: "user";
  content: string;
}

export interface AssistantMessage {
  role: "assistant";
  content: string;
  toolCalls?: ToolCallRequest[];
}

export interface ToolResultMessage {
  role: "tool";
  toolCallId: string;
  toolName: string;
  content: string;
}

export type ConversationMessage = UserMessage | AssistantMessage | ToolResultMessage;
