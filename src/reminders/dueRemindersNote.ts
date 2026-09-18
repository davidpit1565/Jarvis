import type { ReminderStore } from "@/reminders/ReminderStore";

const DEFAULT_UPCOMING_WINDOW_MS = 60 * 60 * 1000; // 60 minutes

/**
 * Formats a note about due/overdue *and* soon-due reminders for the
 * system prompt, or undefined when there are none. This is what makes
 * JARVIS proactively mention "you have a reminder due" (or "coming up")
 * at the start of a conversation instead of only ever answering exactly
 * what was asked — matching how real personal assistants actually behave
 * (surfacing what's relevant, not just responding to explicit requests).
 *
 * Upcoming reminders (due within `upcomingWindowMs` from now, default 60
 * minutes) are called out separately from overdue ones — "starts in 20
 * minutes" is actionable in a way "was due 3 days ago" isn't, so they
 * shouldn't be flattened into one list.
 */
export function dueRemindersNote(
  reminderStore: ReminderStore,
  upcomingWindowMs: number = DEFAULT_UPCOMING_WINDOW_MS
): string | undefined {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const soonIso = new Date(nowMs + upcomingWindowMs).toISOString();

  const overdue = reminderStore.list().filter((r) => r.dueAt !== null && r.dueAt <= nowIso);
  const upcoming = reminderStore
    .list()
    .filter((r) => r.dueAt !== null && r.dueAt > nowIso && r.dueAt <= soonIso);

  if (overdue.length === 0 && upcoming.length === 0) return undefined;

  const sections: string[] = [];

  if (overdue.length > 0) {
    const lines = overdue.map((r) => `- ${r.text} (was due ${r.dueAt})`).join("\n");
    sections.push(
      `The user has ${overdue.length} reminder(s) due now or overdue — mention ` +
        `this naturally near the start of your reply if it fits, without ` +
        `being asked:\n${lines}`
    );
  }

  if (upcoming.length > 0) {
    const lines = upcoming.map((r) => `- ${r.text} (due ${r.dueAt})`).join("\n");
    sections.push(
      `The user also has ${upcoming.length} reminder(s) coming up soon — ` +
        `worth a brief heads-up if it fits naturally:\n${lines}`
    );
  }

  return sections.join("\n\n");
}
