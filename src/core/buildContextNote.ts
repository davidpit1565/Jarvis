import type { JarvisConfig } from "@/config";
import type { ReminderStore } from "@/reminders/ReminderStore";
import type { GoogleCalendarClient } from "@/calendar/GoogleCalendarClient";
import type { CommitmentStore } from "@/commitments/CommitmentStore";
import type { GoalStore } from "@/agent/GoalStore";
import type { AgentTaskStore } from "@/agent/AgentTaskStore";
import { currentTimeNote } from "@/core/time/currentTimeNote";
import { dueRemindersNote } from "@/reminders/dueRemindersNote";
import { todayCalendarNote } from "@/calendar/todayCalendarNote";
import { staleCommitmentsNote } from "@/commitments/staleCommitmentsNote";
import { goalProgressNote } from "@/agent/goalProgressNote";

/**
 * Combines every per-turn context note into the single string Orchestrator's
 * `contextProvider` expects. Kept as one small composition point rather
 * than wiring each note separately at both Orchestrator call sites
 * (terminal + phone) in index.ts. Async because calendar context requires
 * a real API call; the reminder/time/commitment/goal notes stay
 * synchronous internally. `commitmentStore` and the `goalStore`/
 * `taskStore`/`userId` trio are optional so call sites that predate them
 * (or tests) don't have to construct a Goal Engine just to build a
 * context note — both goal params must be given together or neither is
 * consulted.
 */
export async function buildContextNote(
  config: Pick<JarvisConfig, "timezone">,
  reminderStore: ReminderStore,
  calendarClient?: GoogleCalendarClient,
  commitmentStore?: CommitmentStore,
  goals?: { goalStore: GoalStore; taskStore: AgentTaskStore; userId: string }
): Promise<string> {
  const calendarNote = calendarClient ? await todayCalendarNote(calendarClient) : undefined;
  return [
    currentTimeNote(config.timezone),
    dueRemindersNote(reminderStore),
    calendarNote,
    commitmentStore ? staleCommitmentsNote(commitmentStore) : undefined,
    goals ? goalProgressNote(goals.goalStore, goals.taskStore, goals.userId) : undefined,
  ]
    .filter(Boolean)
    .join("\n\n");
}
