import { describe, test, expect } from "bun:test";
import { isMorningBriefingDue } from "@/digest/isMorningBriefingDue";

describe("isMorningBriefingDue", () => {
  test("due when the time matches and it hasn't sent today", () => {
    expect(isMorningBriefingDue("07:00", "07:00", "2026-01-15", null)).toBe(true);
  });

  test("not due when the time doesn't match", () => {
    expect(isMorningBriefingDue("07:00", "07:01", "2026-01-15", null)).toBe(false);
  });

  test("not due again on the same day once already sent", () => {
    expect(isMorningBriefingDue("07:00", "07:00", "2026-01-15", "2026-01-15")).toBe(false);
  });

  test("due again the next day even at the same time", () => {
    expect(isMorningBriefingDue("07:00", "07:00", "2026-01-16", "2026-01-15")).toBe(true);
  });
});
