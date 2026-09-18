import { describe, test, expect } from "bun:test";
import { MemoryStore } from "@/memory/MemoryStore";

describe("MemoryStore", () => {
  test("saves and retrieves a record", () => {
    const store = new MemoryStore(":memory:");
    const record = store.save({ key: "greeting", value: "hello" });

    const fetched = store.get(record.id);
    expect(fetched?.value).toBe("hello");
    store.close();
  });

  test("returns null for an unknown id", () => {
    const store = new MemoryStore(":memory:");
    expect(store.get("missing-id")).toBeNull();
    store.close();
  });

  test("searches records by key fragment", () => {
    const store = new MemoryStore(":memory:");
    store.save({ key: "user.name", value: "David" });
    store.save({ key: "user.email", value: "dp@example.com" });
    store.save({ key: "device.mac", value: "MacBook" });

    const results = store.search("user.");
    expect(results).toHaveLength(2);
    store.close();
  });

  test("searches records by value fragment too, not just key", () => {
    const store = new MemoryStore(":memory:");
    store.save({ key: "pets.name", value: "a golden retriever named Max" });
    store.save({ key: "user.name", value: "David" });

    const results = store.search("retriever");
    expect(results).toHaveLength(1);
    expect(results[0]?.key).toBe("pets.name");
    store.close();
  });

  test("deletes a record", () => {
    const store = new MemoryStore(":memory:");
    const record = store.save({ key: "temp", value: "value" });

    expect(store.delete(record.id)).toBe(true);
    expect(store.get(record.id)).toBeNull();
    store.close();
  });

  test("delete returns false for unknown id", () => {
    const store = new MemoryStore(":memory:");
    expect(store.delete("missing-id")).toBe(false);
    store.close();
  });

  test("saving the same key twice replaces the value instead of adding a second row", () => {
    const store = new MemoryStore(":memory:");
    store.save({ key: "user.timezone", value: "America/New_York" });
    store.save({ key: "user.timezone", value: "Asia/Jerusalem" });

    const results = store.search("user.timezone");
    expect(results).toHaveLength(1);
    expect(results[0]?.value).toBe("Asia/Jerusalem");
    store.close();
  });

  test("upserting a key keeps its original id", () => {
    const store = new MemoryStore(":memory:");
    const first = store.save({ key: "user.name", value: "David" });
    const second = store.save({ key: "user.name", value: "Dave" });

    expect(second.id).toBe(first.id);
    store.close();
  });

  test("deleteByKey removes the record", () => {
    const store = new MemoryStore(":memory:");
    store.save({ key: "temp", value: "value" });

    expect(store.deleteByKey("temp")).toBe(true);
    expect(store.search("temp")).toEqual([]);
    store.close();
  });

  test("deleteByKey returns false for an unknown key", () => {
    const store = new MemoryStore(":memory:");
    expect(store.deleteByKey("missing")).toBe(false);
    store.close();
  });

  test("getByKey returns the matching record", () => {
    const store = new MemoryStore(":memory:");
    store.save({ key: "user.name", value: "David" });

    expect(store.getByKey("user.name")?.value).toBe("David");
    store.close();
  });

  test("getByKey returns null for an unknown key", () => {
    const store = new MemoryStore(":memory:");
    expect(store.getByKey("missing")).toBeNull();
    store.close();
  });

  test("a file-backed store uses WAL journal mode", () => {
    const dbPath = `/tmp/jarvis-memory-test-${crypto.randomUUID()}.sqlite`;
    const store = new MemoryStore(dbPath);
    const mode = (store as unknown as { db: { query: (sql: string) => { get: () => { journal_mode: string } } } }).db
      .query("PRAGMA journal_mode")
      .get();
    expect(mode.journal_mode).toBe("wal");
    store.close();
  });
});
