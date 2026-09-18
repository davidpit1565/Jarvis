const WEEKDAY_SHORT_TO_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Day of week (0=Sunday..6=Saturday) for `date` in `timeZone`. */
export function getDayOfWeek(date: Date, timeZone: string): number {
  const short = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(date);
  return WEEKDAY_SHORT_TO_INDEX[short] ?? 0;
}

/**
 * Pure matching logic for the weekly usage digest, mirroring
 * getDueWakeUpCalls's separation of "is it due right now" from the
 * scheduler's setInterval/network code so it's unit-testable without
 * timers. Due once per week, at the configured day+time, in the
 * configured timezone; `lastSentDateKey` (the "YYYY-MM-DD" it last
 * actually sent on) stops it firing twice within the same matching
 * minute or on every tick for the rest of that minute.
 */
export function isWeeklyDigestDue(
  now: Date,
  timeZone: string,
  dayOfWeek: number,
  timeOfDay: string,
  nowTimeOfDay: string,
  todayDateKey: string,
  lastSentDateKey: string | null
): boolean {
  return (
    getDayOfWeek(now, timeZone) === dayOfWeek && nowTimeOfDay === timeOfDay && lastSentDateKey !== todayDateKey
  );
}
