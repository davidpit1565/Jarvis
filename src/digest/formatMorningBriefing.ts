import type { CurrentWeather } from "@/weather/OpenMeteoClient";
import type { CalendarEvent } from "@/types/calendar";
import type { ReminderRecord } from "@/types/reminders";

/**
 * Plain-text daily morning briefing — weather, today's calendar, and due/
 * overdue reminders — meant to be pushed via NOTIFY_USER-style delivery
 * (Telegram) so the user gets it unprompted each morning instead of only
 * ever being answerable if asked. Each section is optional: whichever
 * pieces weren't configured (no weather location, no calendar link) or
 * have nothing to report are simply omitted, never shown as empty.
 */
export function formatMorningBriefing(
  weather: CurrentWeather | undefined,
  todaysEvents: CalendarEvent[],
  dueOrOverdueReminders: ReminderRecord[]
): string {
  const lines = ["Good morning! Here's your briefing:"];

  if (weather) {
    lines.push(`Weather: ${weather.temperatureC}°C, ${weather.description}.`);
  }

  if (todaysEvents.length > 0) {
    lines.push("Today's calendar:");
    for (const event of todaysEvents) {
      lines.push(`- ${event.summary} (${event.start}${event.location ? `, ${event.location}` : ""})`);
    }
  }

  if (dueOrOverdueReminders.length > 0) {
    lines.push("Due or overdue reminders:");
    for (const reminder of dueOrOverdueReminders) {
      lines.push(`- ${reminder.text}${reminder.dueAt ? ` (due ${reminder.dueAt})` : ""}`);
    }
  }

  return lines.join("\n");
}
