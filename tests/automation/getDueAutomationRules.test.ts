import { describe, test, expect } from "bun:test";
import { getDueAutomationRules } from "@/automation/getDueAutomationRules";
import type { AutomationRuleRecord } from "@/types/automationRules";

function makeRule(overrides: Partial<AutomationRuleRecord> = {}): AutomationRuleRecord {
  return {
    id: "rule-1",
    timeOfDay: "08:00",
    instruction: "check the weather",
    enabled: true,
    lastTriggeredDate: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("getDueAutomationRules", () => {
  test("matches a rule whose time-of-day equals now and hasn't run today", () => {
    const rule = makeRule({ timeOfDay: "08:00" });
    expect(getDueAutomationRules([rule], "08:00", "2026-01-15")).toEqual([rule]);
  });

  test("excludes a rule at a different time", () => {
    const rule = makeRule({ timeOfDay: "09:00" });
    expect(getDueAutomationRules([rule], "08:00", "2026-01-15")).toEqual([]);
  });

  test("excludes a disabled rule even at the matching time", () => {
    const rule = makeRule({ timeOfDay: "08:00", enabled: false });
    expect(getDueAutomationRules([rule], "08:00", "2026-01-15")).toEqual([]);
  });

  test("excludes a rule that already ran today", () => {
    const rule = makeRule({ timeOfDay: "08:00", lastTriggeredDate: "2026-01-15" });
    expect(getDueAutomationRules([rule], "08:00", "2026-01-15")).toEqual([]);
  });

  test("includes a rule that ran on a previous day", () => {
    const rule = makeRule({ timeOfDay: "08:00", lastTriggeredDate: "2026-01-14" });
    expect(getDueAutomationRules([rule], "08:00", "2026-01-15")).toEqual([rule]);
  });

  test("excludes a rule whose id is in excludeIds, even though it's otherwise due", () => {
    const rule = makeRule({ id: "rule-in-flight", timeOfDay: "08:00" });
    const due = getDueAutomationRules([rule], "08:00", "2026-01-15", new Set(["rule-in-flight"]));
    expect(due).toEqual([]);
  });

  test("still includes a due rule whose id isn't in excludeIds", () => {
    const rule = makeRule({ id: "rule-2", timeOfDay: "08:00" });
    const due = getDueAutomationRules([rule], "08:00", "2026-01-15", new Set(["some-other-rule"]));
    expect(due).toEqual([rule]);
  });
});
