import type { ReminderTone } from "@/types/reminders";

/**
 * Builds the actual spoken text for a proactive, device-announced reminder
 * (CLAUDE.md wishlist #19). Deliberately a small pure function, not a
 * templating system: `tone` is the one tunable knob David asked for
 * ("a tone he can tune, more casual vs. more professional/diplomatic") —
 * anything fancier is out of scope for this pass. `null`/omitted tone
 * behaves like "casual".
 *
 * `isFollowUp` switches to the "did you do it?" check-in phrasing used by
 * the bounded follow-up engine (see getAnnounceFollowUps) instead of the
 * initial interruption phrasing.
 */
export function composeAnnouncementText(reminderText: string, tone: ReminderTone | null, isFollowUp: boolean): string {
  const resolvedTone = tone ?? "casual";

  if (isFollowUp) {
    return resolvedTone === "formal"
      ? `Sir, following up — have you had a chance to take care of: ${reminderText}?`
      : `Hey, quick check-in — did you get a chance to do: ${reminderText}?`;
  }

  return resolvedTone === "formal"
    ? `Sir, pardon the interruption. A reminder: ${reminderText}.`
    : `Hey David, sorry to interrupt, but you have: ${reminderText}.`;
}
