import { describe, test, expect } from "bun:test";
import { isWeeklyDigestDue, getDayOfWeek } from "@/digest/isWeeklyDigestDue";

describe("getDayOfWeek", () => {
  test("returns 0 for a Sunday", () => {
    // 2026-01-04 is a Sunday.
    expect(getDayOfWeek(new Date("2026-01-04T12:00:00Z"), "UTC")).toBe(0);
  });

  test("returns 1 for a Monday", () => {
    expect(getDayOfWeek(new Date("2026-01-05T12:00:00Z"), "UTC")).toBe(1);
  });
});

describe("isWeeklyDigestDue", () => {
  const monday = new Date("2026-01-05T09:00:00Z");

  test("is due when day and time match and it hasn't already sent today", () => {
    expect(isWeeklyDigestDue(monday, "UTC", 1, "09:00", "09:00", "2026-01-05", null)).toBe(true);
  });

  test("is not due on the wrong day", () => {
    expect(isWeeklyDigestDue(monday, "UTC", 2, "09:00", "09:00", "2026-01-05", null)).toBe(false);
  });

  test("is not due at the wrong time", () => {
    expect(isWeeklyDigestDue(monday, "UTC", 1, "10:00", "09:00", "2026-01-05", null)).toBe(false);
  });

  test("is not due again the same day it already sent", () => {
    expect(isWeeklyDigestDue(monday, "UTC", 1, "09:00", "09:00", "2026-01-05", "2026-01-05")).toBe(false);
  });

  test("is due again a week later even with a lastSentDateKey from last time", () => {
    expect(isWeeklyDigestDue(monday, "UTC", 1, "09:00", "09:00", "2026-01-05", "2025-12-29")).toBe(true);
  });
});
