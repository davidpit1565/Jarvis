import type { WakeUpCallRecord } from "@/types/wakeUpCalls";

/**
 * Pure matching logic, kept separate from the scheduler's setInterval/
 * network code so it's actually unit-testable without timers or a real
 * Twilio account. A call is due when its time-of-day matches right now
 * and it hasn't already gone out today — the second check is what stops
 * it firing repeatedly every tick within the same matching minute.
 */
export function getDueWakeUpCalls(
  calls: WakeUpCallRecord[],
  nowTimeOfDay: string,
  todayDateStr: string
): WakeUpCallRecord[] {
  return calls.filter(
    (call) => call.enabled && call.timeOfDay === nowTimeOfDay && call.lastTriggeredDate !== todayDateStr
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
