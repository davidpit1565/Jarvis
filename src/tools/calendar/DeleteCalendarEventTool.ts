import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { GoogleCalendarClient } from "@/calendar/GoogleCalendarClient";

export interface DeleteCalendarEventInput extends Record<string, unknown> {
  eventId: string;
}

/**
 * Lets the user undo a calendar event JARVIS created (or any event they
 * want gone) by its id — without this, create_calendar_event's own claim
 * of being reversible ("delete it if it's wrong") would be an empty
 * promise. SAFE_ACTION and standing-granted, matching delete_reminder.
 */
export function createDeleteCalendarEventTool(calendarClient: GoogleCalendarClient): LocalTool<DeleteCalendarEventInput> {
  return {
    id: "DELETE_CALENDAR_EVENT",
    name: "delete_calendar_event",
    description: "Deletes a Google Calendar event by its id (from a prior create_calendar_event or list_calendar_events call).",
    inputSchema: {
      type: "object",
      properties: {
        eventId: { type: "string", description: "The event's id." },
      },
      required: ["eventId"],
    },
    requiredPermission: PermissionLevel.SAFE_ACTION,
    target: "local",

    async execute(input) {
      if (typeof input.eventId !== "string" || input.eventId.trim() === "") {
        return { success: false, error: "eventId must be a non-empty string" };
      }

      try {
        await calendarClient.deleteEvent(input.eventId);
        return { success: true, data: { eventId: input.eventId } };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
