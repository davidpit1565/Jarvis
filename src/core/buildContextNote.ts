import type { JarvisConfig } from "@/config";
import type { ReminderStore } from "@/reminders/ReminderStore";
import type { GoogleCalendarClient } from "@/calendar/GoogleCalendarClient";
import { currentTimeNote } from "@/core/time/currentTimeNote";
import { dueRemindersNote } from "@/reminders/dueRemindersNote";
import { todayCalendarNote } from "@/calendar/todayCalendarNote";

/**
 * Combines every per-turn context note into the single string Orchestrator's
 * `contextProvider` expects. Kept as one small composition point rather
 * than wiring each note separately at both Orchestrator call sites
 * (terminal + phone) in index.ts. Async because calendar context requires
 * a real API call; the reminder/time notes stay synchronous internally.
 */
export async function buildContextNote(
  config: Pick<JarvisConfig, "timezone">,
  reminderStore: ReminderStore,
  calendarClient?: GoogleCalendarClient
): Promise<string> {
  const calendarNote = calendarClient ? await todayCalendarNote(calendarClient) : undefined;
  return [currentTimeNote(config.timezone), dueRemindersNote(reminderStore), calendarNote].filter(Boolean).join("\n\n");
}
