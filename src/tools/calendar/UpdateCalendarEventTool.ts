import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { GoogleCalendarClient } from "@/calendar/GoogleCalendarClient";
import type { UndoStore } from "@/core/undo/UndoStore";

export interface UpdateCalendarEventInput extends Record<string, unknown> {
  eventId: string;
  summary?: string;
  start?: string;
  end?: string;
  location?: string | null;
}

function isValidIsoDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

/**
 * Edits an existing calendar event's title, time, and/or location in
 * place, given its id — without this, the only way to change anything
 * about an event was delete-then-recreate, which loses its id and drops
 * attendees/description for no reason. SAFE_ACTION and standing-granted,
 * matching CREATE_CALENDAR_EVENT/DELETE_CALENDAR_EVENT.
 *
 * When an `undoStore` is provided, fetches the event's current field
 * values before patching it and records them so "undo that" can restore
 * them — same fetch-then-act pattern as DELETE_CALENDAR_EVENT's own undo
 * support.
 */
export function createUpdateCalendarEventTool(
  calendarClient: GoogleCalendarClient,
  undoStore?: UndoStore
): LocalTool<UpdateCalendarEventInput> {
  return {
    id: "UPDATE_CALENDAR_EVENT",
    name: "update_calendar_event",
    description:
      "Edits an existing Google Calendar event's title, start/end time, and/or location in place, given " +
      'its id (from a prior create_calendar_event or list/search_calendar_events call). Omit a field to ' +
      'leave it unchanged; pass location as null to clear it. Use this for "actually move that to 4pm" ' +
      "rather than deleting and recreating the event.",
    inputSchema: {
      type: "object",
      properties: {
        eventId: { type: "string", description: "The event's id." },
        summary: { type: "string", description: "New title. Omit to leave unchanged." },
        start: { type: "string", description: "New ISO 8601 start timestamp. Omit to leave unchanged." },
        end: { type: "string", description: "New ISO 8601 end timestamp. Omit to leave unchanged." },
        location: { type: "string", description: "New location, or null to clear it. Omit to leave unchanged." },
      },
      required: ["eventId"],
    },
    requiredPermission: PermissionLevel.SAFE_ACTION,
    target: "local",

    async execute(input) {
      if (typeof input.eventId !== "string" || input.eventId.trim() === "") {
        return { success: false, error: "eventId must be a non-empty string" };
      }
      if (input.summary !== undefined && (typeof input.summary !== "string" || input.summary.trim() === "")) {
        return { success: false, error: "summary must be a non-empty string when provided" };
      }
      if (input.start !== undefined && (typeof input.start !== "string" || !isValidIsoDate(input.start))) {
        return { success: false, error: "start must be a valid ISO 8601 timestamp" };
      }
      if (input.end !== undefined && (typeof input.end !== "string" || !isValidIsoDate(input.end))) {
        return { success: false, error: "end must be a valid ISO 8601 timestamp" };
      }
      if (input.location !== undefined && input.location !== null && typeof input.location !== "string") {
        return { success: false, error: "location must be a string or null" };
      }

      try {
        const eventBeforeUpdate = await calendarClient.getEvent(input.eventId).catch(() => null);

        const effectiveStart = input.start ?? eventBeforeUpdate?.start;
        const effectiveEnd = input.end ?? eventBeforeUpdate?.end;
        if (
          effectiveStart &&
          effectiveEnd &&
          Date.parse(effectiveEnd) <= Date.parse(effectiveStart)
        ) {
          return { success: false, error: "end must be after start" };
        }

        const event = await calendarClient.updateEvent(input.eventId, {
          summary: input.summary,
          start: input.start,
          end: input.end,
          location: input.location,
        });

        if (eventBeforeUpdate) {
          undoStore?.record({
            type: "calendar_event_updated",
            eventId: input.eventId,
            previous: {
              summary: eventBeforeUpdate.summary,
              start: eventBeforeUpdate.start,
              end: eventBeforeUpdate.end,
              location: eventBeforeUpdate.location,
            },
          });
        }

        return { success: true, data: { event } };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
