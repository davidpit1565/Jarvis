import type { JarvisConfig } from "@/config";
import type { ReminderStore } from "@/reminders/ReminderStore";
import { currentTimeNote } from "@/core/time/currentTimeNote";
import { dueRemindersNote } from "@/reminders/dueRemindersNote";

/**
 * Combines every per-turn context note into the single string Orchestrator's
 * `contextProvider` expects. Kept as one small composition point rather
 * than wiring each note separately at both Orchestrator call sites
 * (terminal + phone) in index.ts.
 */
export function buildContextNote(config: Pick<JarvisConfig, "timezone">, reminderStore: ReminderStore): string {
  return [currentTimeNote(config.timezone), dueRemindersNote(reminderStore)].filter(Boolean).join("\n\n");
}
