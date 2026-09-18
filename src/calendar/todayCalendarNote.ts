import type { GoogleCalendarClient } from "@/calendar/GoogleCalendarClient";

/**
 * Formats today's/upcoming Google Calendar events for the system prompt,
 * or undefined when there's nothing to add — mirrors dueRemindersNote's
 * shape, but for real calendar events instead of manually-typed
 * reminders. A failure (not linked yet, Google API hiccup, expired
 * refresh token) is swallowed and treated as "nothing to add" rather than
 * breaking the turn: calendar context is a nice-to-have enrichment, never
 * something a live conversation should fail over.
 */
export async function todayCalendarNote(calendarClient: GoogleCalendarClient): Promise<string | undefined> {
  let events;
  try {
    events = await calendarClient.listUpcomingEvents(5);
  } catch {
    return undefined;
  }

  if (events.length === 0) return undefined;

  const lines = events.map((e) => `- ${e.summary} (${e.start}${e.location ? `, ${e.location}` : ""})`).join("\n");
  return `The user's upcoming calendar events (for context, not necessarily today):\n${lines}`;
}
