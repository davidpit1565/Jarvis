import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { ConversationHistoryStore } from "@/history/ConversationHistoryStore";

export interface SearchConversationHistoryInput extends Record<string, unknown> {
  query: string;
  limit?: number;
}

// A caller passing an unreasonably large limit shouldn't be able to pull
// the entire stored transcript history in one request.
const MAX_LIMIT = 100;

/**
 * Lets Claude answer "what did we talk about" / "did I already tell you
 * about X" by actually searching past conversations, instead of only
 * seeing the current thread or guessing from saved memory. Distinct from
 * SEARCH_MEMORY: memory is explicit facts Claude chose to save; this is
 * the raw transcript, searched after the fact.
 */
export function createSearchConversationHistoryTool(
  historyStore: ConversationHistoryStore
): LocalTool<SearchConversationHistoryInput> {
  return {
    id: "SEARCH_CONVERSATION_HISTORY",
    name: "search_conversation_history",
    description:
      "Searches past conversation transcripts (both what the user said and what JARVIS replied) for a " +
      "substring match, most recent first. Use this for \"what did we talk about\" / \"did I already " +
      'mention..." rather than guessing from the current conversation alone.',
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to search for." },
        limit: { type: "number", description: "Max results to return. Defaults to 10, capped at 100." },
      },
      required: ["query"],
    },
    requiredPermission: PermissionLevel.READ,
    target: "local",

    async execute(input) {
      if (typeof input.query !== "string" || input.query.trim() === "") {
        return { success: false, error: "query must be a non-empty string" };
      }
      const limit =
        typeof input.limit === "number" && input.limit > 0 ? Math.min(Math.floor(input.limit), MAX_LIMIT) : 10;

      const results = historyStore.search(input.query, limit);
      return { success: true, data: { results } };
    },
  };
}
