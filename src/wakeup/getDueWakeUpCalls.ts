import type { WakeUpCallRecord } from "@/types/wakeUpCalls";

/**
 * Pure matching logic, kept separate from the scheduler's setInterval/
 * network code so it's actually unit-testable without timers or a real
 * Twilio account. A call is due when its time-of-day matches right now
 * and it hasn't already gone out today.
 *
 * `lastTriggeredDate` alone only rules a call back out once its call has
 * actually *completed* — a call whose placeCall() is still in flight when
 * the next tick fires (a slow/stuck network request, within the same
 * matching minute) would otherwise still look due and get dialed a
 * second time. `excludeIds` closes that gap: pass the ids the caller has
 * already started placing a call for but hasn't resolved yet.
 */
export function getDueWakeUpCalls(
  calls: WakeUpCallRecord[],
  nowTimeOfDay: string,
  todayDateStr: string,
  excludeIds: ReadonlySet<string> = new Set()
): WakeUpCallRecord[] {
  return calls.filter(
    (call) =>
      call.enabled &&
      call.timeOfDay === nowTimeOfDay &&
      call.lastTriggeredDate !== todayDateStr &&
      !excludeIds.has(call.id)
  );
}

/** "HH:MM" for `date` in `timeZone`, e.g. "07:00". */
export function formatTimeOfDay(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(
    date
  );
}

/** "YYYY-MM-DD" for `date` in `timeZone`. */
export function formatDateKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    date
  );
}
