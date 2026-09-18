import { describe, test, expect } from "bun:test";
import { currentTimeNote } from "@/core/time/currentTimeNote";

describe("currentTimeNote", () => {
  test("includes an ISO UTC timestamp", () => {
    const note = currentTimeNote("UTC");
    expect(note).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  });

  test("includes the configured timezone name", () => {
    const note = currentTimeNote("Asia/Jerusalem");
    expect(note).toContain("Asia/Jerusalem");
  });

  test("tells the model to use this as ground truth for relative times", () => {
    const note = currentTimeNote("UTC");
    expect(note.toLowerCase()).toContain("ground truth");
    expect(note).toContain("create_reminder");
  });

  test("falls back gracefully instead of throwing on an invalid timezone", () => {
    expect(() => currentTimeNote("Not/A_Real_Zone")).not.toThrow();
  });

  test("different timezones produce different local time text", () => {
    const utc = currentTimeNote("UTC");
    const jerusalem = currentTimeNote("Asia/Jerusalem");
    expect(utc).not.toBe(jerusalem);
  });
});
