import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { CalendarTokenStore } from "@/calendar/CalendarTokenStore";

/**
 * Lets the user actually disconnect their linked Google account —
 * without this, once linked via /calendar/oauth/start there was no way
 * to undo it short of manually deleting the SQLite file. DANGEROUS (like
 * CLEAR_CONVERSATION_HISTORY): disconnecting a real third-party account
 * link always needs a fresh confirmation, never something that happens
 * as a side effect of casual conversation.
 */
export function createUnlinkCalendarTool(calendarTokenStore: CalendarTokenStore): LocalTool<Record<string, unknown>> {
  return {
    id: "UNLINK_CALENDAR",
    name: "unlink_calendar",
    description:
      "Disconnects the linked Google Calendar account. After this, list_calendar_events stops working until " +
      "the user re-links via GET /calendar/oauth/start. Use only when the user explicitly asks to disconnect/" +
      "unlink their calendar.",
    inputSchema: { type: "object", properties: {} },
    requiredPermission: PermissionLevel.DANGEROUS,
    target: "local",

    async execute() {
      const wasLinked = calendarTokenStore.isLinked();
      calendarTokenStore.clear();
      return { success: true, data: { wasLinked } };
    },
  };
}
