import { describe, test, expect } from "bun:test";
import {
  isQuietHours,
  isSuppressibleByQuietHours,
  quietHoursEndAt,
  zonedTimeToUtc,
  type QuietHoursWindow,
} from "@/notifications/quietHours";

describe("isQuietHours", () => {
  test("returns false when no window is configured", () => {
    expect(isQuietHours("03:00", undefined)).toBe(false);
  });

  test("returns false for a zero-length window (start === end)", () => {
    const window: QuietHoursWindow = { start: "22:00", end: "22:00" };
    expect(isQuietHours("22:00", window)).toBe(false);
    expect(isQuietHours("03:00", window)).toBe(false);
  });

  test("normal (non-overnight) window: inside the window", () => {
    const window: QuietHoursWindow = { start: "13:00", end: "14:00" };
    expect(isQuietHours("13:30", window)).toBe(true);
  });

  test("normal (non-overnight) window: at the start boundary is inside, at the end boundary is outside", () => {
    const window: QuietHoursWindow = { start: "13:00", end: "14:00" };
    expect(isQuietHours("13:00", window)).toBe(true);
    expect(isQuietHours("14:00", window)).toBe(false);
  });

  test("normal (non-overnight) window: outside the window", () => {
    const window: QuietHoursWindow = { start: "13:00", end: "14:00" };
    expect(isQuietHours("15:00", window)).toBe(false);
  });

  test("overnight window (22:00-07:00): a 3am reminder falls inside quiet hours", () => {
    const window: QuietHoursWindow = { start: "22:00", end: "07:00" };
    expect(isQuietHours("03:00", window)).toBe(true);
  });

  test("overnight window: late evening also falls inside quiet hours", () => {
    const window: QuietHoursWindow = { start: "22:00", end: "07:00" };
    expect(isQuietHours("23:30", window)).toBe(true);
  });

  test("overnight window: a 3pm reminder does NOT fall inside quiet hours", () => {
    const window: QuietHoursWindow = { start: "22:00", end: "07:00" };
    expect(isQuietHours("15:00", window)).toBe(false);
  });

  test("overnight window: exactly at the start is quiet, exactly at the end is not", () => {
    const window: QuietHoursWindow = { start: "22:00", end: "07:00" };
    expect(isQuietHours("22:00", window)).toBe(true);
    expect(isQuietHours("07:00", window)).toBe(false);
  });
});

describe("isSuppressibleByQuietHours (opt-out per notification type)", () => {
  test("alarms are exempt — never suppressed by quiet hours", () => {
    expect(isSuppressibleByQuietHours("alarm")).toBe(false);
  });

  test("wake-up calls are exempt — never suppressed by quiet hours", () => {
    expect(isSuppressibleByQuietHours("wakeup_call")).toBe(false);
  });

  test("reminders are suppressible by default", () => {
    expect(isSuppressibleByQuietHours("reminder")).toBe(true);
  });

  test("automation rule result pushes are suppressible by default", () => {
    expect(isSuppressibleByQuietHours("automation_rule_result")).toBe(true);
  });

  test("the morning briefing is suppressible by default", () => {
    expect(isSuppressibleByQuietHours("morning_briefing")).toBe(true);
  });
});

describe("zonedTimeToUtc", () => {
  test("converts a UTC wall-clock date/time to the matching instant", () => {
    const result = zonedTimeToUtc("2026-01-16", "07:00", "UTC");
    expect(result.toISOString()).toBe("2026-01-16T07:00:00.000Z");
  });
});

describe("quietHoursEndAt", () => {
  const window: QuietHoursWindow = { start: "22:00", end: "07:00" };

  test("before-midnight portion: now=23:30 on Jan 15 -> ends 07:00 on Jan 16 (UTC)", () => {
    const now = new Date("2026-01-15T23:30:00.000Z");
    const end = quietHoursEndAt(now, "UTC", window);
    expect(end.toISOString()).toBe("2026-01-16T07:00:00.000Z");
  });

  test("after-midnight portion: now=05:00 on Jan 16 -> ends 07:00 that same day (UTC)", () => {
    const now = new Date("2026-01-16T05:00:00.000Z");
    const end = quietHoursEndAt(now, "UTC", window);
    expect(end.toISOString()).toBe("2026-01-16T07:00:00.000Z");
  });

  test("right at the start boundary: now=22:00 on Jan 15 -> ends 07:00 on Jan 16 (UTC)", () => {
    const now = new Date("2026-01-15T22:00:00.000Z");
    const end = quietHoursEndAt(now, "UTC", window);
    expect(end.toISOString()).toBe("2026-01-16T07:00:00.000Z");
  });

  test("a same-day (non-overnight) window computes the end on the current date", () => {
    const sameDayWindow: QuietHoursWindow = { start: "13:00", end: "14:00" };
    const now = new Date("2026-01-15T13:30:00.000Z");
    const end = quietHoursEndAt(now, "UTC", sameDayWindow);
    expect(end.toISOString()).toBe("2026-01-15T14:00:00.000Z");
  });
});
