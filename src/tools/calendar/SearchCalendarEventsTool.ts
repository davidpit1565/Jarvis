import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { GoogleCalendarClient } from "@/calendar/GoogleCalendarClient";

export interface SearchCalendarEventsInput extends Record<string, unknown> {
  query: string;
  maxResults?: number;
}

/**
 * Finds calendar events by free-text query (title/description/location/
 * attendees), not limited to upcoming events like LIST_CALENDAR_EVENTS —
 * lets Claude answer "when was my dentist appointment" or "find the event
 * with Sarah" instead of only "what's coming up". READ-only, same as
 * listing.
 */
export function createSearchCalendarEventsTool(
  calendarClient: GoogleCalendarClient
): LocalTool<SearchCalendarEventsInput> {
  return {
    id: "SEARCH_CALENDAR_EVENTS",
    name: "search_calendar_events",
    description:
      "Searches the user's Google Calendar events (past and future) by free-text query, matching against " +
      'title, description, location, and attendees. Use this for questions like "when was my dentist ' +
      'appointment" or "find the event with Sarah" — for just "what\'s coming up", use list_calendar_events instead.',
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The free-text search query." },
        maxResults: { type: "number", description: "Maximum number of events to return. Defaults to 10." },
      },
      required: ["query"],
    },
    requiredPermission: PermissionLevel.READ,
    target: "local",

    async execute(input) {
      if (typeof input.query !== "string" || input.query.trim().length === 0) {
        return { success: false, error: "query must be a non-empty string" };
      }
      const maxResults = typeof input.maxResults === "number" ? input.maxResults : undefined;
      if (maxResults !== undefined && (!Number.isInteger(maxResults) || maxResults <= 0)) {
        return { success: false, error: "maxResults must be a positive integer" };
      }

      try {
        const events = await calendarClient.searchEvents(input.query, maxResults);
        return { success: true, data: { events } };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
