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

  test("defaults to kind 'info', but records the given kind", () => {
    const log = new ActivityLog();
    log.record("plain event");
    log.record("JARVIS is thinking…", "thinking");
    log.record("Here's your answer.", "speaking");

    const [speaking, thinking, info] = log.list();
    expect(info!.kind).toBe("info");
    expect(thinking!.kind).toBe("thinking");
    expect(speaking!.kind).toBe("speaking");
  });

  test("with no dbPath, behaves purely in-memory (no persistence)", () => {
    const log = new ActivityLog();
    log.record("ephemeral");
    log.close(); // must not throw with no backing db
  });
});

describe("ActivityLog persistence", () => {
  test("activity survives across instances backed by the same SQLite file", () => {
    const dbPath = `/tmp/jarvis-activity-test-${crypto.randomUUID()}.sqlite`;

    const first = new ActivityLog(dbPath);
    first.record("first entry");
    first.record("second entry", "thinking");
    first.close();

    const second = new ActivityLog(dbPath);
    const messages = second.list().map((e) => e.message);
    expect(messages).toEqual(["second entry", "first entry"]);
    second.close();
  });

  test("a fresh in-memory log (no dbPath) starts empty even after a persisted log recorded entries", () => {
    const dbPath = `/tmp/jarvis-activity-test-${crypto.randomUUID()}.sqlite`;
    const persisted = new ActivityLog(dbPath);
    persisted.record("only in the persisted one");
    persisted.close();

    const ephemeral = new ActivityLog();
    expect(ephemeral.list()).toEqual([]);
  });

  test("reloads at most the in-memory cap even if more rows are persisted", () => {
    const dbPath = `/tmp/jarvis-activity-test-${crypto.randomUUID()}.sqlite`;

    const first = new ActivityLog(dbPath);
    for (let i = 0; i < 35; i++) first.record(`entry-${i}`);
    first.close();

    const second = new ActivityLog(dbPath);
    expect(second.list().length).toBe(30);
    expect(second.list()[0]!.message).toBe("entry-34");
    second.close();
  });
});
