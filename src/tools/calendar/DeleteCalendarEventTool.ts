import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { GoogleCalendarClient } from "@/calendar/GoogleCalendarClient";
import type { UndoStore } from "@/core/undo/UndoStore";

export interface DeleteCalendarEventInput extends Record<string, unknown> {
  eventId: string;
  /** Which linked Google account the event is on, by email. Only needed if it can't be found automatically (e.g. more than one account is linked and the event wasn't just listed/searched). */
  account?: string;
}

/**
 * Lets the user undo a calendar event JARVIS created (or any event they
 * want gone) by its id — without this, create_calendar_event's own claim
 * of being reversible ("delete it if it's wrong") would be an empty
 * promise. SAFE_ACTION and standing-granted, matching delete_reminder.
 *
 * When an `undoStore` is provided, fetches the event's details before
 * deleting it and records enough (summary/start/end/location) to recreate
 * it on "undo that" — a deletion is only actually reversible if something
 * remembered what was deleted. Fetch-then-delete has an unavoidable, low-
 * consequence race (the event could change between the two calls) that
 * isn't worth guarding against for a single-user personal assistant.
 */
export function createDeleteCalendarEventTool(
  calendarClient: GoogleCalendarClient,
  undoStore?: UndoStore
): LocalTool<DeleteCalendarEventInput> {
  return {
    id: "DELETE_CALENDAR_EVENT",
    name: "delete_calendar_event",
    description: "Deletes a Google Calendar event by its id (from a prior create_calendar_event or list_calendar_events call).",
    inputSchema: {
      type: "object",
      properties: {
        eventId: { type: "string", description: "The event's id." },
        account: {
          type: "string",
          description:
            "Which linked Google account the event is on, by email. Usually not needed — resolved automatically from the event id; only pass this if the automatic lookup fails (multiple accounts linked and the event's account isn't already known).",
        },
      },
      required: ["eventId"],
    },
    requiredPermission: PermissionLevel.SAFE_ACTION,
    target: "local",

    async execute(input) {
      if (typeof input.eventId !== "string" || input.eventId.trim() === "") {
        return { success: false, error: "eventId must be a non-empty string" };
      }
      if (input.account !== undefined && typeof input.account !== "string") {
        return { success: false, error: "account must be a string" };
      }

      try {
        const eventBeforeDelete = await calendarClient.getEvent(input.eventId, input.account).catch(() => null);
        await calendarClient.deleteEvent(input.eventId, input.account ?? eventBeforeDelete?.account);
        if (eventBeforeDelete) {
          undoStore?.record({
            type: "calendar_event_deleted",
            summary: eventBeforeDelete.summary,
            start: eventBeforeDelete.start,
            end: eventBeforeDelete.end,
            location: eventBeforeDelete.location,
            account: eventBeforeDelete.account,
          });
        }
        return { success: true, data: { eventId: input.eventId } };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
