import { describe, test, expect } from "bun:test";
import { getDueAlarms } from "@/alarms/getDueAlarms";
import type { AlarmRecord } from "@/types/alarms";

function makeAlarm(overrides: Partial<AlarmRecord> = {}): AlarmRecord {
  return {
    id: "alarm-1",
    timeOfDay: "07:00",
    label: null,
    enabled: true,
    lastTriggeredDate: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("getDueAlarms", () => {
  test("matches an alarm whose time-of-day equals now and hasn't fired today", () => {
    const alarm = makeAlarm({ timeOfDay: "07:00" });
    expect(getDueAlarms([alarm], "07:00", "2026-01-15")).toEqual([alarm]);
  });

  test("excludes an alarm at a different time", () => {
    const alarm = makeAlarm({ timeOfDay: "08:00" });
    expect(getDueAlarms([alarm], "07:00", "2026-01-15")).toEqual([]);
  });

  test("excludes a disabled alarm even at the matching time", () => {
    const alarm = makeAlarm({ timeOfDay: "07:00", enabled: false });
    expect(getDueAlarms([alarm], "07:00", "2026-01-15")).toEqual([]);
  });

  test("excludes an alarm that already fired today", () => {
    const alarm = makeAlarm({ timeOfDay: "07:00", lastTriggeredDate: "2026-01-15" });
    expect(getDueAlarms([alarm], "07:00", "2026-01-15")).toEqual([]);
  });

  test("includes an alarm that fired on a previous day", () => {
    const alarm = makeAlarm({ timeOfDay: "07:00", lastTriggeredDate: "2026-01-14" });
    expect(getDueAlarms([alarm], "07:00", "2026-01-15")).toEqual([alarm]);
  });

  test("excludes an alarm whose id is in excludeIds, even though it's otherwise due", () => {
    const alarm = makeAlarm({ id: "alarm-in-flight", timeOfDay: "07:00" });
    const due = getDueAlarms([alarm], "07:00", "2026-01-15", new Set(["alarm-in-flight"]));
    expect(due).toEqual([]);
  });

  test("still includes a due alarm whose id isn't in excludeIds", () => {
    const alarm = makeAlarm({ id: "alarm-2", timeOfDay: "07:00" });
    const due = getDueAlarms([alarm], "07:00", "2026-01-15", new Set(["some-other-alarm"]));
    expect(due).toEqual([alarm]);
  });
});
