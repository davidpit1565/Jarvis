import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { UndoStore } from "@/core/undo/UndoStore";
import type { GoogleCalendarClient } from "@/calendar/GoogleCalendarClient";
import type { ReminderStore } from "@/reminders/ReminderStore";
import type { MemoryStore } from "@/memory/MemoryStore";

/**
 * Lets the user say "undo that" right after JARVIS did something, instead
 * of having to describe and manually reverse it themselves. Only reverses
 * the single most recent undoable action (see UndoStore) — this is
 * deliberately not a general history/rollback system, just the one thing
 * "undo" naturally refers to right after doing it.
 *
 * `calendarClient`/`reminderStore`/`memoryStore` are each only needed to
 * undo their own action types (calendar_event_* / reminder_deleted /
 * memory_deleted respectively) — omit whichever isn't configured, and
 * undoing an action of that type simply reports it can't be undone
 * rather than throwing.
 */
export function createUndoLastActionTool(
  undoStore: UndoStore,
  calendarClient?: GoogleCalendarClient,
  reminderStore?: ReminderStore,
  memoryStore?: MemoryStore
): LocalTool {
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
          if (!calendarClient) return { success: false, error: "Calendar isn't linked; can't undo this" };
          await calendarClient.deleteEvent(action.eventId);
          return { success: true, data: { undone: action.type, summary: action.summary } };
        }
        if (action.type === "calendar_event_deleted") {
          if (!calendarClient) return { success: false, error: "Calendar isn't linked; can't undo this" };
          await calendarClient.createEvent(
            {
              summary: action.summary,
              start: action.start,
              end: action.end,
              location: action.location,
            },
            action.account
          );
          return { success: true, data: { undone: action.type, summary: action.summary } };
        }
        if (action.type === "calendar_event_updated") {
          if (!calendarClient) return { success: false, error: "Calendar isn't linked; can't undo this" };
          await calendarClient.updateEvent(action.eventId, action.previous);
          return { success: true, data: { undone: action.type, summary: action.previous.summary } };
        }
        if (action.type === "reminder_deleted") {
          if (!reminderStore) return { success: false, error: "Reminders aren't available; can't undo this" };
          reminderStore.create({ text: action.text, dueAt: action.dueAt, recurrence: action.recurrence });
          return { success: true, data: { undone: action.type, text: action.text } };
        }
        if (action.type === "memory_deleted") {
          if (!memoryStore) return { success: false, error: "Memory isn't available; can't undo this" };
          memoryStore.save({
            key: action.key,
            value: action.value,
            category: action.category,
            importance: action.importance,
            expiresAt: action.expiresAt,
            source: action.source,
          });
          return { success: true, data: { undone: action.type, key: action.key } };
        }
        return { success: false, error: `Don't know how to undo action type: ${(action as { type: string }).type}` };
      } catch (error) {
        // The actual reversal (a Calendar/Gmail API call) failed — restore
        // the record instead of leaving it lost. Without this, a transient
        // network/OAuth hiccup on the one call that matters most (undoing
        // a mistake) would silently and permanently destroy the undo
        // record, even though nothing was actually undone.
        undoStore.record(action);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
