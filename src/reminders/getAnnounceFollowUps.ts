import type { ReminderRecord } from "@/types/reminders";

/**
 * Bounded follow-up budget for a proactive, device-announced reminder
 * (CLAUDE.md wishlist #19: "If he doesn't respond, JARVIS should follow up
 * ... rather than firing once and moving on" — explicitly bounded, not
 * infinite nagging). Two follow-ups beyond the initial announcement: a
 * reasonable "did you do it?" / one more check before giving up.
 */
export const MAX_ANNOUNCE_FOLLOW_UPS = 2;

/** How long to wait after the initial announcement (or the previous follow-up) before checking in again. */
export const ANNOUNCE_FOLLOW_UP_INTERVAL_MS = 5 * 60_000;

/**
 * Pure matching logic for the follow-up engine's scheduled check, kept
 * separate from the setInterval/store-mutation code so it's unit-testable
 * without timers — same pattern as getStaleCommitments/getDueWakeUpCalls.
 *
 * A reminder needs a follow-up when: it's an `announce` reminder that has
 * already received its initial spoken announcement (`notifiedAt` set),
 * nobody has yet authenticated a reply to it (`acknowledgedAt` still
 * null), it hasn't exhausted its follow-up budget, and enough time has
 * passed since the last attempt (or the initial announcement, if there's
 * been no follow-up yet). `excludeIds` closes the same in-flight gap
 * getStaleCommitments/getDueWakeUpCalls already close: a reminder whose
 * follow-up send is still in flight when the next tick fires shouldn't be
 * picked up a second time.
 */
export function getAnnounceFollowUps(
  reminders: ReminderRecord[],
  nowIso: string,
  excludeIds: ReadonlySet<string> = new Set()
): ReminderRecord[] {
  const nowMs = Date.parse(nowIso);
  return reminders.filter((r) => {
    if (!r.announce) return false;
    if (r.acknowledgedAt !== null) return false;
    if (r.notifiedAt === null) return false;
    if (r.followUpCount >= MAX_ANNOUNCE_FOLLOW_UPS) return false;
    if (excludeIds.has(r.id)) return false;

    const sinceIso = r.lastFollowUpAt ?? r.notifiedAt;
    return nowMs - Date.parse(sinceIso) >= ANNOUNCE_FOLLOW_UP_INTERVAL_MS;
  });
}
