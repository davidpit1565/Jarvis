import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { UndoStore } from "@/core/undo/UndoStore";
import type { GoogleCalendarClient } from "@/calendar/GoogleCalendarClient";

/**
 * Lets the user say "undo that" right after JARVIS did something, instead
 * of having to describe and manually reverse it themselves. Only reverses
 * the single most recent undoable action (see UndoStore) — this is
 * deliberately not a general history/rollback system, just the one thing
 * "undo" naturally refers to right after doing it.
 */
export function createUndoLastActionTool(undoStore: UndoStore, calendarClient: GoogleCalendarClient): LocalTool {
  return {
    id: "UNDO_LAST_ACTION",
    name: "undo_last_action",
    description:
      'Undoes the single most recent reversible action JARVIS took (e.g. a just-created calendar event), if any. Use this when the user says "undo that" / "never mind, undo it".',
    inputSchema: { type: "object", properties: {} },
    requiredPermission: PermissionLevel.SAFE_ACTION,
    target: "local",

    async execute() {
      const action = undoStore.takeLast();
      if (!action) {
        return { success: false, error: "Nothing to undo" };
      }

      try {
        if (action.type === "calendar_event_created") {
          await calendarClient.deleteEvent(action.eventId);
          return { success: true, data: { undone: action.type, summary: action.summary } };
        }
        if (action.type === "calendar_event_deleted") {
          await calendarClient.createEvent({
            summary: action.summary,
            start: action.start,
            end: action.end,
            location: action.location,
          });
          return { success: true, data: { undone: action.type, summary: action.summary } };
        }
        return { success: false, error: `Don't know how to undo action type: ${(action as { type: string }).type}` };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
