export interface ConversationHistoryEntry {
  id: number;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}
