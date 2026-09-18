import { describe, test, expect } from "bun:test";
import { getDueWakeUpCalls, formatTimeOfDay, formatDateKey } from "@/wakeup/getDueWakeUpCalls";
import type { WakeUpCallRecord } from "@/types/wakeUpCalls";

function makeCall(overrides: Partial<WakeUpCallRecord> = {}): WakeUpCallRecord {
  return {
    id: "call-1",
    timeOfDay: "07:00",
    label: null,
    enabled: true,
    lastTriggeredDate: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("getDueWakeUpCalls", () => {
  test("matches a call whose time-of-day equals now and hasn't fired today", () => {
    const call = makeCall({ timeOfDay: "07:00" });
    expect(getDueWakeUpCalls([call], "07:00", "2026-01-15")).toEqual([call]);
  });

  test("excludes a call at a different time", () => {
    const call = makeCall({ timeOfDay: "08:00" });
    expect(getDueWakeUpCalls([call], "07:00", "2026-01-15")).toEqual([]);
  });

  test("excludes a disabled call even at the matching time", () => {
    const call = makeCall({ timeOfDay: "07:00", enabled: false });
    expect(getDueWakeUpCalls([call], "07:00", "2026-01-15")).toEqual([]);
  });

  test("excludes a call that already triggered today", () => {
    const call = makeCall({ timeOfDay: "07:00", lastTriggeredDate: "2026-01-15" });
    expect(getDueWakeUpCalls([call], "07:00", "2026-01-15")).toEqual([]);
  });

  test("includes a call that triggered on a previous day", () => {
    const call = makeCall({ timeOfDay: "07:00", lastTriggeredDate: "2026-01-14" });
    expect(getDueWakeUpCalls([call], "07:00", "2026-01-15")).toEqual([call]);
  });
});

describe("formatTimeOfDay", () => {
  test("formats as 24-hour HH:MM in the given timezone", () => {
    const date = new Date("2026-01-15T05:03:00Z");
    expect(formatTimeOfDay(date, "UTC")).toBe("05:03");
  });
});

describe("formatDateKey", () => {
  test("formats as YYYY-MM-DD in the given timezone", () => {
    const date = new Date("2026-01-15T05:03:00Z");
    expect(formatDateKey(date, "UTC")).toBe("2026-01-15");
  });

  test("crosses a day boundary correctly for a non-UTC timezone", () => {
    // 2026-01-15T23:30:00Z is already 2026-01-16 in UTC+1
    const date = new Date("2026-01-15T23:30:00Z");
    expect(formatDateKey(date, "Europe/Paris")).toBe("2026-01-16");
  });
});
