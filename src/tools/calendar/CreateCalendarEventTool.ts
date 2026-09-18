import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { GoogleCalendarClient } from "@/calendar/GoogleCalendarClient";
import type { UndoStore } from "@/core/undo/UndoStore";

export interface CreateCalendarEventInput extends Record<string, unknown> {
  summary: string;
  start: string;
  end: string;
  location?: string;
}

function isValidIsoDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

/**
 * Lets the user actually get something added to their real Google
 * Calendar by asking JARVIS, not just ask what's already on it.
 * SAFE_ACTION and standing-granted, matching create_reminder: creating an
 * event is exactly as reversible as creating a reminder (delete it if
 * it's wrong), and requiring an interactive confirmation on every single
 * calendar add would defeat the point of just asking JARVIS to add it.
 */
export function createCreateCalendarEventTool(
  calendarClient: GoogleCalendarClient,
  undoStore?: UndoStore
): LocalTool<CreateCalendarEventInput> {
  return {
    id: "CREATE_CALENDAR_EVENT",
    name: "create_calendar_event",
    description:
      "Creates a new event on the user's Google Calendar. Resolve any relative time the user gave " +
      '("tomorrow at 3pm", "next Monday morning") into actual ISO 8601 timestamps yourself before calling ' +
      "this. Always creates the event even if it overlaps an existing one — a non-empty `conflicts` field " +
      "in the result means it does, so mention that to the user rather than silently double-booking them.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "The event's title." },
        start: { type: "string", description: "ISO 8601 timestamp the event starts at." },
        end: { type: "string", description: "ISO 8601 timestamp the event ends at." },
        location: { type: "string", description: "Optional location." },
      },
      required: ["summary", "start", "end"],
    },
    requiredPermission: PermissionLevel.SAFE_ACTION,
    target: "local",

    async execute(input) {
      if (typeof input.summary !== "string" || input.summary.trim() === "") {
        return { success: false, error: "summary must be a non-empty string" };
      }
      if (typeof input.start !== "string" || !isValidIsoDate(input.start)) {
        return { success: false, error: "start must be a valid ISO 8601 timestamp" };
      }
      if (typeof input.end !== "string" || !isValidIsoDate(input.end)) {
        return { success: false, error: "end must be a valid ISO 8601 timestamp" };
      }
      if (Date.parse(input.end) <= Date.parse(input.start)) {
        return { success: false, error: "end must be after start" };
      }
      if (input.location !== undefined && typeof input.location !== "string") {
        return { success: false, error: "location must be a string" };
      }

      try {
        // Checked before creating so a conflict lookup failure never
        // blocks the actual create — this is a nice-to-have warning, not
        // a gate on the action itself.
        const conflicts = await calendarClient.listEventsInRange(input.start, input.end).catch(() => []);

        const event = await calendarClient.createEvent({
          summary: input.summary,
          start: input.start,
          end: input.end,
          location: input.location ?? null,
        });
        undoStore?.record({ type: "calendar_event_created", eventId: event.id, summary: event.summary });
        return { success: true, data: { event, conflicts } };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
