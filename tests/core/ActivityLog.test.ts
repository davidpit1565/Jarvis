import { describe, test, expect } from "bun:test";
import { ActivityLog } from "@/core/activity/ActivityLog";

describe("ActivityLog", () => {
  test("returns recorded entries newest first", () => {
    const log = new ActivityLog();
    log.record("a");
    log.record("b");
    log.record("c");

    expect(log.list().map((e) => e.message)).toEqual(["c", "b", "a"]);
  });

  test("caps at 30 entries, dropping the oldest", () => {
    const log = new ActivityLog();
    for (let i = 0; i < 35; i++) log.record(`entry-${i}`);

    const messages = log.list().map((e) => e.message);
    expect(messages.length).toBe(30);
    expect(messages[0]).toBe("entry-34");
    expect(messages[messages.length - 1]).toBe("entry-5");
  });

  test("each entry has an ISO timestamp", () => {
    const log = new ActivityLog();
    log.record("hello");
    const [entry] = log.list();
    expect(entry).toBeDefined();
    expect(() => new Date(entry!.timestamp).toISOString()).not.toThrow();
  });
});
