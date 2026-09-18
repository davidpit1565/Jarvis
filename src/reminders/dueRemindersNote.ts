import type { ReminderStore } from "@/reminders/ReminderStore";

/**
 * Formats a note about due/overdue reminders for the system prompt, or
 * undefined when there are none. This is what makes JARVIS proactively
 * mention "you have a reminder due" at the start of a conversation instead
 * of only ever answering exactly what was asked — matching how real
 * personal assistants actually behave (surfacing what's relevant, not just
 * responding to explicit requests).
 */
export function dueRemindersNote(reminderStore: ReminderStore): string | undefined {
  const now = new Date().toISOString();
  const due = reminderStore.list().filter((r) => r.dueAt !== null && r.dueAt <= now);
  if (due.length === 0) return undefined;

  const lines = due.map((r) => `- ${r.text} (was due ${r.dueAt})`).join("\n");
  return (
    `The user has ${due.length} reminder(s) due now or overdue — mention ` +
    `this naturally near the start of your reply if it fits, without ` +
    `being asked:\n${lines}`
  );
}
