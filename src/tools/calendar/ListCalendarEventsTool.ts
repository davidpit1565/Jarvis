import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { GoogleCalendarClient } from "@/calendar/GoogleCalendarClient";

export interface ListCalendarEventsInput extends Record<string, unknown> {
  maxResults?: number;
}

/**
 * Lets Claude answer "what's on my calendar" / "do I have anything today"
 * with the user's real Google Calendar, not just what's been manually
 * typed into reminders. READ-only — JARVIS never creates or edits
 * calendar events, only looks at them.
 */
export function createListCalendarEventsTool(calendarClient: GoogleCalendarClient): LocalTool<ListCalendarEventsInput> {
  return {
    id: "LIST_CALENDAR_EVENTS",
    name: "list_calendar_events",
    description:
      "Lists the user's upcoming Google Calendar events, soonest first, starting from right now. Use this to " +
      'answer questions about meetings/appointments/schedule ("what do I have today", "am I free at 3pm").',
    inputSchema: {
      type: "object",
      properties: {
        maxResults: { type: "number", description: "Maximum number of events to return. Defaults to 10." },
      },
    },
    requiredPermission: PermissionLevel.READ,
    target: "local",

    async execute(input) {
      const maxResults = typeof input.maxResults === "number" ? input.maxResults : undefined;
      if (maxResults !== undefined && (!Number.isInteger(maxResults) || maxResults <= 0)) {
        return { success: false, error: "maxResults must be a positive integer" };
      }

      try {
        const events = await calendarClient.listUpcomingEvents(maxResults);
        return { success: true, data: { events } };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
