import type { CommitmentStore } from "@/commitments/CommitmentStore";

/**
 * Formats a note about stale commitments for the system prompt, or
 * undefined when there are none — the "surfaced the same way overdue
 * reminders are" half of the follow-up engine (see dueRemindersNote's own
 * doc comment for the same reasoning). The scheduled check in index.ts
 * (getStaleCommitments + CommitmentStore.markStale) is what actually
 * transitions a commitment to "stale"; this just reads that persisted
 * state and turns it into proactive context, exactly like dueRemindersNote
 * reads ReminderStore — there's no separate notification channel for
 * this, on purpose (see JARVIS_ROADMAP_AUDIT.md #128/#129).
 */
export function staleCommitmentsNote(commitmentStore: CommitmentStore): string | undefined {
  const stale = commitmentStore.list("stale");
  if (stale.length === 0) return undefined;

  const lines = stale
    .map((c) => `- ${c.text}${c.dueContext ? ` (said: ${c.dueContext})` : ""}`)
    .join("\n");

  return (
    `The user has ${stale.length} open commitment(s) that have gone stale — something JARVIS or the ` +
    `user said would happen, that hasn't been followed up on in a while. Consider mentioning this and ` +
    `offering to follow up now, or asking whether it's still relevant:\n${lines}`
  );
}
