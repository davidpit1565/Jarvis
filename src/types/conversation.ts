export type ConversationRole = "user" | "assistant" | "tool";

export interface ToolCallRequest {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
}

/** A single attached image on a user turn — base64, not a URL, matching Anthropic's own inline-image contract. */
export interface UserMessageImage {
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  /** Base64-encoded image bytes, no data: URI prefix. */
  data: string;
}

export interface UserMessage {
  role: "user";
  content: string;
  /** Optional images attached to this turn — real vision, not just a filename. Empty/omitted for a text-only turn. */
  images?: UserMessageImage[];
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
