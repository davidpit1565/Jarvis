import { describe, test, expect } from "bun:test";
import { isCheckinDue } from "@/digest/isCheckinDue";

describe("isCheckinDue", () => {
  const lastInteraction = new Date("2026-01-01T00:00:00Z");

  test("is not due before the threshold", () => {
    const now = new Date("2026-01-01T23:00:00Z");
    expect(isCheckinDue(now, lastInteraction, 24, false)).toBe(false);
  });

  test("is due once the threshold is reached", () => {
    const now = new Date("2026-01-02T00:00:00Z");
    expect(isCheckinDue(now, lastInteraction, 24, false)).toBe(true);
  });

  test("is due past the threshold too", () => {
    const now = new Date("2026-01-05T00:00:00Z");
    expect(isCheckinDue(now, lastInteraction, 24, false)).toBe(true);
  });

  test("is not due again if already sent since the last interaction", () => {
    const now = new Date("2026-01-05T00:00:00Z");
    expect(isCheckinDue(now, lastInteraction, 24, true)).toBe(false);
  });
});
