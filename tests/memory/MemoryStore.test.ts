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

  describe("category and importance (Memory Quality Layer)", () => {
    test("defaults category to 'fact' and importance to 3 when omitted", () => {
      const store = new MemoryStore(":memory:");
      const record = store.save({ key: "user.name", value: "David" });

      expect(record.category).toBe("fact");
      expect(record.importance).toBe(3);
      store.close();
    });

    test("round-trips an explicit category and importance", () => {
      const store = new MemoryStore(":memory:");
      const record = store.save({ key: "user.pref.editor", value: "vim", category: "preference", importance: 5 });

      expect(record.category).toBe("preference");
      expect(record.importance).toBe(5);
      expect(store.getByKey("user.pref.editor")).toEqual(record);
      store.close();
    });

    test("a pre-existing untyped row (no category/importance columns populated) defaults sensibly when read back", () => {
      const store = new MemoryStore(":memory:");
      // Simulate a Phase 1 row written before category/importance existed —
      // insert directly, bypassing save()'s defaulting.
      (store as unknown as { db: { query: (sql: string) => { run: (...args: unknown[]) => void } } }).db
        .query(`INSERT INTO memory_records (id, key, value, created_at) VALUES (?, ?, ?, ?)`)
        .run("legacy-id", "legacy.key", "legacy value", new Date().toISOString());

      const record = store.get("legacy-id");
      expect(record?.category).toBe("fact");
      expect(record?.importance).toBe(3);
      expect(record?.expiresAt).toBeNull();
      store.close();
    });
  });

  describe("expiration (Memory Expiration)", () => {
    test("a non-temporary memory has no expiry by default", () => {
      const store = new MemoryStore(":memory:");
      const record = store.save({ key: "user.name", value: "David" });
      expect(record.expiresAt).toBeNull();
      store.close();
    });

    test("a 'temporary' memory gets a default future expiry when none is given", () => {
      const store = new MemoryStore(":memory:");
      const record = store.save({ key: "session.topic", value: "discussing travel plans", category: "temporary" });

      expect(record.expiresAt).not.toBeNull();
      expect(new Date(record.expiresAt as string).getTime()).toBeGreaterThan(Date.now());
      store.close();
    });

    test("an explicit expiresAt overrides the temporary default", () => {
      const store = new MemoryStore(":memory:");
      const explicit = new Date(Date.now() + 60_000).toISOString();
      const record = store.save({ key: "session.topic", value: "x", category: "temporary", expiresAt: explicit });
      expect(record.expiresAt).toBe(explicit);
      store.close();
    });

    test("getActive excludes expired memories but includes non-expired and never-expiring ones", () => {
      const store = new MemoryStore(":memory:");
      const past = new Date(Date.now() - 60_000).toISOString();
      const future = new Date(Date.now() + 60_000).toISOString();

      store.save({ key: "expired.fact", value: "gone", expiresAt: past });
      store.save({ key: "active.fact", value: "still here", expiresAt: future });
      store.save({ key: "permanent.fact", value: "forever" });

      const active = store.getActive();
      const keys = active.map((r) => r.key);
      expect(keys).not.toContain("expired.fact");
      expect(keys).toContain("active.fact");
      expect(keys).toContain("permanent.fact");
      store.close();
    });

    test("purgeExpired removes only expired rows and reports how many", () => {
      const store = new MemoryStore(":memory:");
      const past = new Date(Date.now() - 60_000).toISOString();
      store.save({ key: "expired.fact", value: "gone", expiresAt: past });
      store.save({ key: "permanent.fact", value: "forever" });

      const purged = store.purgeExpired();
      expect(purged).toBe(1);
      expect(store.getByKey("expired.fact")).toBeNull();
      expect(store.getByKey("permanent.fact")).not.toBeNull();
      store.close();
    });
  });

  describe("conflict history (Memory Conflict Resolver)", () => {
    test("overwriting a key with a meaningfully different value logs old -> new history and still upserts", () => {
      const store = new MemoryStore(":memory:");
      store.save({ key: "user.timezone", value: "America/New_York" });
      store.save({ key: "user.timezone", value: "Asia/Jerusalem" });

      expect(store.getByKey("user.timezone")?.value).toBe("Asia/Jerusalem");

      const history = store.getHistory("user.timezone");
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        memoryKey: "user.timezone",
        oldValue: "America/New_York",
        newValue: "Asia/Jerusalem",
      });
      expect(typeof history[0]?.changedAt).toBe("string");
      store.close();
    });

    test("saving the same value again (no meaningful change) does not add a history entry", () => {
      const store = new MemoryStore(":memory:");
      store.save({ key: "user.timezone", value: "America/New_York" });
      store.save({ key: "user.timezone", value: "America/New_York" });

      expect(store.getHistory("user.timezone")).toHaveLength(0);
      store.close();
    });

    test("first save of a brand-new key logs no history", () => {
      const store = new MemoryStore(":memory:");
      store.save({ key: "user.name", value: "David" });
      expect(store.getHistory("user.name")).toHaveLength(0);
      store.close();
    });

    test("multiple corrections accumulate multiple history entries in order", () => {
      const store = new MemoryStore(":memory:");
      store.save({ key: "user.job", value: "Engineer" });
      store.save({ key: "user.job", value: "Manager" });
      store.save({ key: "user.job", value: "Director" });

      const history = store.getHistory("user.job");
      expect(history).toHaveLength(2);
      expect(history[0]).toMatchObject({ oldValue: "Engineer", newValue: "Manager" });
      expect(history[1]).toMatchObject({ oldValue: "Manager", newValue: "Director" });
      store.close();
    });
  });
});
