import type { AlarmRecord } from "@/types/alarms";

/**
 * Pure matching logic, same reasoning as getDueWakeUpCalls: kept separate
 * from the scheduler's setInterval code so it's unit-testable without
 * timers or a real Telegram bot. An alarm is due when its time-of-day
 * matches right now and it hasn't already fired today.
 */
export function getDueAlarms(
  alarms: AlarmRecord[],
  nowTimeOfDay: string,
  todayDateStr: string,
  excludeIds: ReadonlySet<string> = new Set()
): AlarmRecord[] {
  return alarms.filter(
    (alarm) =>
      alarm.enabled &&
      alarm.timeOfDay === nowTimeOfDay &&
      alarm.lastTriggeredDate !== todayDateStr &&
      !excludeIds.has(alarm.id)
  );
}
