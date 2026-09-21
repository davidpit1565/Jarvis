import { describe, test, expect } from "bun:test";
import { NotificationDedup } from "@/notifications/NotificationDedup";

describe("NotificationDedup", () => {
  test("allows the first send of a given key", () => {
    const dedup = new NotificationDedup(60_000);
    expect(dedup.shouldSend("key-1", 1_000)).toBe(true);
  });

  test("suppresses a duplicate send of the same key within the window", () => {
    const dedup = new NotificationDedup(60_000);
    expect(dedup.shouldSend("key-1", 1_000)).toBe(true);
    expect(dedup.shouldSend("key-1", 30_000)).toBe(false);
  });

  test("allows the same key again once the window has passed", () => {
    const dedup = new NotificationDedup(60_000);
    expect(dedup.shouldSend("key-1", 1_000)).toBe(true);
    expect(dedup.shouldSend("key-1", 61_001)).toBe(true);
  });

  test("different keys never suppress each other", () => {
    const dedup = new NotificationDedup(60_000);
    expect(dedup.shouldSend("key-1", 1_000)).toBe(true);
    expect(dedup.shouldSend("key-2", 1_000)).toBe(true);
  });

  test("a resent duplicate resets the window from the new send time", () => {
    const dedup = new NotificationDedup(60_000);
    expect(dedup.shouldSend("key-1", 1_000)).toBe(true);
    expect(dedup.shouldSend("key-1", 61_001)).toBe(true); // window passed, allowed + re-records
    expect(dedup.shouldSend("key-1", 61_500)).toBe(false); // now within the new window
  });
});
