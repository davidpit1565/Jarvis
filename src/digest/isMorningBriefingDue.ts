/**
 * Pure matching logic for the daily morning briefing, mirroring
 * isWeeklyDigestDue/isCheckinDue's separation of "is it due right now"
 * from the scheduler's setInterval/network code so it's unit-testable
 * without timers. Due once per day, at the configured time; `lastSentDateKey`
 * (the "YYYY-MM-DD" it last actually sent on) stops it firing twice within
 * the same matching minute or on every tick for the rest of that minute.
 */
export function isMorningBriefingDue(
  timeOfDay: string,
  nowTimeOfDay: string,
  todayDateKey: string,
  lastSentDateKey: string | null
): boolean {
  return nowTimeOfDay === timeOfDay && lastSentDateKey !== todayDateKey;
}
