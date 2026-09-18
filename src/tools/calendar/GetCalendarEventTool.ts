import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { GoogleCalendarClient } from "@/calendar/GoogleCalendarClient";

export interface GetCalendarEventInput extends Record<string, unknown> {
  eventId: string;
}

/**
 * LIST/SEARCH_CALENDAR_EVENTS only return summary/start/end/location —
 * this fetches one event's full detail by id, including its description
 * and attendee emails, for when the user asks what an event is actually
 * about or who's invited. READ-only, same as listing/searching.
 */
export function createGetCalendarEventTool(calendarClient: GoogleCalendarClient): LocalTool<GetCalendarEventInput> {
  return {
    id: "GET_CALENDAR_EVENT",
    name: "get_calendar_event",
    description:
      "Fetches one calendar event's full detail by id (from a prior list/search_calendar_events result), " +
      "including its description and attendees — not returned by listing or searching. Use this when the " +
      "user asks what an event is about or who's invited. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        eventId: { type: "string", description: "The event id, as returned by list_calendar_events or search_calendar_events." },
      },
      required: ["eventId"],
    },
    requiredPermission: PermissionLevel.READ,
    target: "local",

    async execute(input) {
      const eventId = typeof input.eventId === "string" ? input.eventId.trim() : "";
      if (!eventId) {
        return { success: false, error: "eventId must be a non-empty string" };
      }

      try {
        const event = await calendarClient.getEvent(eventId);
        return { success: true, data: { event } };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
