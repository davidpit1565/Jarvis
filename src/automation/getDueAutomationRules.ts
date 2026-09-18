import type { AutomationRuleRecord } from "@/types/automationRules";

/**
 * Pure matching logic, kept separate from the scheduler's setInterval/
 * network code so it's actually unit-testable without timers — same
 * pattern as getDueWakeUpCalls. A rule is due when its time-of-day
 * matches right now and it hasn't already run today.
 *
 * `excludeIds` closes the same in-flight gap getDueWakeUpCalls closes: a
 * rule whose instruction is still being run through the Orchestrator
 * when the next tick fires (a slow turn, within the same matching
 * minute) would otherwise look due and get triggered a second time.
 */
export function getDueAutomationRules(
  rules: AutomationRuleRecord[],
  nowTimeOfDay: string,
  todayDateStr: string,
  excludeIds: ReadonlySet<string> = new Set()
): AutomationRuleRecord[] {
  return rules.filter(
    (rule) =>
      rule.enabled &&
      rule.timeOfDay === nowTimeOfDay &&
      rule.lastTriggeredDate !== todayDateStr &&
      !excludeIds.has(rule.id)
  );
}
