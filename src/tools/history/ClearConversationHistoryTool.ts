import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { ConversationHistoryStore } from "@/history/ConversationHistoryStore";

/**
 * Lets the user actually erase their stored conversation transcript —
 * without this, "forget everything we've talked about" had no real
 * mechanism: SEARCH_CONVERSATION_HISTORY could find old turns, but
 * nothing could remove them. DANGEROUS (not SAFE_ACTION like the memory/
 * reminder deletes) because it's irreversible and total: one call erases
 * every retained turn, not a single named record, so it always needs a
 * fresh human confirmation even with a standing grant.
 */
export function createClearConversationHistoryTool(
  conversationHistoryStore: ConversationHistoryStore
): LocalTool<Record<string, unknown>> {
  return {
    id: "CLEAR_CONVERSATION_HISTORY",
    name: "clear_conversation_history",
    description:
      "Permanently erases the entire stored conversation transcript (used by search_conversation_history). " +
      "Use only when the user explicitly asks to forget/delete everything discussed — this cannot be undone " +
      "and removes every past turn, not just one.",
    inputSchema: { type: "object", properties: {} },
    requiredPermission: PermissionLevel.DANGEROUS,
    target: "local",

    async execute() {
      const deletedCount = conversationHistoryStore.clear();
      return { success: true, data: { deletedCount } };
    },
  };
}
