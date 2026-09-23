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

  test("a literal underscore in the search fragment is not treated as a single-character wildcard", () => {
    const store = new MemoryStore(":memory:");
    store.save({ key: "wifi_password", value: "Home5G!" });
    store.save({ key: "wifi.password", value: "Guest99" }); // differs only by _ vs .

    const results = store.search("wifi_password");
    expect(results).toHaveLength(1);
    expect(results[0]?.key).toBe("wifi_password");
    store.close();
  });

  test("a literal percent sign in the search fragment is not treated as a multi-character wildcard", () => {
    const store = new MemoryStore(":memory:");
    store.save({ key: "costco.membership", value: "50% loyalty discount" });
    store.save({ key: "other.deal", value: "50 xyz loyalty program" }); // would wrongly match "50% loyalty" as a LIKE pattern

    const results = store.search("50% loyalty");
    expect(results).toHaveLength(1);
    expect(results[0]?.key).toBe("costco.membership");
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

  test("saving the same key with different casing replaces the value instead of adding a second row", () => {
    const store = new MemoryStore(":memory:");
    store.save({ key: "user.timezone", value: "America/New_York" });
    store.save({ key: "user.Timezone", value: "Europe/London" });

    expect(store.getByKey("user.timezone")?.value).toBe("Europe/London");
    // Only one row exists regardless of which casing is used to search.
    expect(store.search("timezone")).toHaveLength(1);
    store.close();
  });

  test("getByKey matches regardless of the key's casing", () => {
    const store = new MemoryStore(":memory:");
    store.save({ key: "user.name", value: "David" });

    expect(store.getByKey("User.Name")?.value).toBe("David");
    expect(store.getByKey("USER.NAME")?.value).toBe("David");
    store.close();
  });

  test("deleteByKey matches regardless of the key's casing", () => {
    const store = new MemoryStore(":memory:");
    store.save({ key: "user.name", value: "David" });

    expect(store.deleteByKey("User.Name")).toBe(true);
    expect(store.getByKey("user.name")).toBeNull();
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

    test("a resave that omits category/importance preserves the existing record's values instead of resetting to defaults", () => {
      const store = new MemoryStore(":memory:");
      store.save({ key: "user.pref.editor", value: "vim", category: "preference", importance: 5 });

      const record = store.save({ key: "user.pref.editor", value: "neovim" });

      expect(record.value).toBe("neovim");
      expect(record.category).toBe("preference");
      expect(record.importance).toBe(5);
      expect(store.getByKey("user.pref.editor")).toEqual(record);
      store.close();
    });

    test("a resave with an explicit category/importance still overrides the existing record's values", () => {
      const store = new MemoryStore(":memory:");
      store.save({ key: "user.pref.editor", value: "vim", category: "preference", importance: 5 });

      const record = store.save({ key: "user.pref.editor", value: "vim", category: "fact", importance: 1 });

      expect(record.category).toBe("fact");
      expect(record.importance).toBe(1);
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

    test("a resave that omits expiresAt preserves the existing record's expiry instead of recomputing it", () => {
      const store = new MemoryStore(":memory:");
      const explicit = new Date(Date.now() + 60_000).toISOString();
      store.save({ key: "session.topic", value: "x", category: "temporary", expiresAt: explicit });

      const record = store.save({ key: "session.topic", value: "y" });

      expect(record.expiresAt).toBe(explicit);
      store.close();
    });

    test("changing an existing record's category to 'temporary' with no explicit expiresAt applies the default TTL, instead of inheriting the old category's null expiry forever", () => {
      const store = new MemoryStore(":memory:");
      store.save({ key: "note.wifi_guest_password", value: "guest123" }); // category defaults to "fact", expiresAt: null

      const record = store.save({ key: "note.wifi_guest_password", value: "guest456", category: "temporary" });

      expect(record.category).toBe("temporary");
      expect(record.expiresAt).not.toBeNull();
      expect(new Date(record.expiresAt as string).getTime()).toBeGreaterThan(Date.now());
      store.close();
    });

    test("changing an existing 'temporary' record's category away from temporary, with no explicit expiresAt, clears the inherited expiry", () => {
      const store = new MemoryStore(":memory:");
      store.save({ key: "session.topic", value: "x", category: "temporary" });

      const record = store.save({ key: "session.topic", value: "y", category: "fact" });

      expect(record.category).toBe("fact");
      expect(record.expiresAt).toBeNull();
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

  describe("Memory Trust System", () => {
    test("defaults source to USER_STATED when omitted", () => {
      const store = new MemoryStore(":memory:");
      const record = store.save({ key: "user.name", value: "David" });
      expect(record.source).toBe("USER_STATED");
      store.close();
    });

    test("round-trips an explicit source", () => {
      const store = new MemoryStore(":memory:");
      const record = store.save({ key: "user.mood", value: "seems stressed lately", source: "MODEL_INFERRED" });
      expect(record.source).toBe("MODEL_INFERRED");
      expect(store.getByKey("user.mood")?.source).toBe("MODEL_INFERRED");
      store.close();
    });

    test("a pre-existing row with no source column defaults to USER_STATED when read back", () => {
      const store = new MemoryStore(":memory:");
      (store as unknown as { db: { query: (sql: string) => { run: (...args: unknown[]) => void } } }).db
        .query(`INSERT INTO memory_records (id, key, value, created_at) VALUES (?, ?, ?, ?)`)
        .run("legacy-id-2", "legacy.key2", "legacy value", new Date().toISOString());

      expect(store.get("legacy-id-2")?.source).toBe("USER_STATED");
      store.close();
    });

    test("an equal-trust write (USER_STATED replacing USER_STATED) still overwrites, unchanged from before", () => {
      const store = new MemoryStore(":memory:");
      store.save({ key: "user.timezone", value: "America/New_York", source: "USER_STATED" });
      const second = store.save({ key: "user.timezone", value: "Asia/Jerusalem", source: "USER_STATED" });

      expect(second.conflict).toBeFalsy();
      expect(store.getByKey("user.timezone")?.value).toBe("Asia/Jerusalem");
      store.close();
    });

    test("a higher-trust write overwrites a lower-trust existing value", () => {
      const store = new MemoryStore(":memory:");
      store.save({ key: "user.job", value: "guessing: works in tech", source: "MODEL_INFERRED" });
      const correction = store.save({ key: "user.job", value: "Software Engineer at Acme", source: "USER_STATED" });

      expect(correction.conflict).toBeFalsy();
      expect(store.getByKey("user.job")?.value).toBe("Software Engineer at Acme");
      expect(store.getByKey("user.job")?.source).toBe("USER_STATED");
      store.close();
    });
  });

  describe("Memory Poisoning Defense", () => {
    test("a MODEL_INFERRED write conflicting with an existing USER_STATED value is rejected, not applied", () => {
      const store = new MemoryStore(":memory:");
      store.save({ key: "user.address", value: "123 Real St", source: "USER_STATED" });

      const attempt = store.save({ key: "user.address", value: "456 Fake Ave", source: "MODEL_INFERRED" });

      expect(attempt.conflict).toBe(true);
      // The returned record is the EXISTING, unchanged value.
      expect(attempt.value).toBe("123 Real St");
      expect(store.getByKey("user.address")?.value).toBe("123 Real St");
      store.close();
    });

    test("an EXTERNAL_CONTENT write (e.g. derived from an email body) cannot overwrite a USER_STATED fact", () => {
      const store = new MemoryStore(":memory:");
      store.save({ key: "user.bank_account", value: "the account the user actually told JARVIS", source: "USER_STATED" });

      const attempt = store.save({
        key: "user.bank_account",
        value: "a different account mentioned in a scam email",
        source: "EXTERNAL_CONTENT",
      });

      expect(attempt.conflict).toBe(true);
      expect(store.getByKey("user.bank_account")?.value).toBe("the account the user actually told JARVIS");
      store.close();
    });

    test("a differently-cased key cannot dodge the poisoning defense — it's still the same logical key", () => {
      const store = new MemoryStore(":memory:");
      store.save({ key: "user.address", value: "123 Real St", source: "USER_STATED" });

      const attempt = store.save({ key: "User.Address", value: "456 Fake Ave", source: "MODEL_INFERRED" });

      expect(attempt.conflict).toBe(true);
      expect(store.getByKey("user.address")?.value).toBe("123 Real St");
      // No second row was created under the case-variant key.
      expect(store.search("address")).toHaveLength(1);
      store.close();
    });

    test("a rejected write is logged to memory_history as a flagged conflict", () => {
      const store = new MemoryStore(":memory:");
      store.save({ key: "user.pin", value: "1111", source: "USER_STATED" });
      store.save({ key: "user.pin", value: "9999", source: "MODEL_INFERRED" });

      const history = store.getHistory("user.pin");
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        oldValue: "1111",
        newValue: "9999",
        oldTrust: "USER_STATED",
        newTrust: "MODEL_INFERRED",
        flaggedConflict: true,
      });
      store.close();
    });

    test("getConflicts returns only flagged (rejected) writes, not ordinary accepted changes", () => {
      const store = new MemoryStore(":memory:");
      store.save({ key: "user.timezone", value: "EST", source: "USER_STATED" });
      store.save({ key: "user.timezone", value: "PST", source: "USER_STATED" }); // accepted, equal trust
      store.save({ key: "user.name", value: "David", source: "USER_STATED" });
      store.save({ key: "user.name", value: "Dave (a guess)", source: "MODEL_INFERRED" }); // rejected

      const conflicts = store.getConflicts();
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]?.memoryKey).toBe("user.name");
      store.close();
    });

    test("getConflicts can be scoped to a single key", () => {
      const store = new MemoryStore(":memory:");
      store.save({ key: "a", value: "1", source: "USER_STATED" });
      store.save({ key: "a", value: "2", source: "MODEL_INFERRED" }); // rejected
      store.save({ key: "b", value: "1", source: "USER_STATED" });
      store.save({ key: "b", value: "2", source: "EXTERNAL_CONTENT" }); // rejected

      expect(store.getConflicts("a")).toHaveLength(1);
      expect(store.getConflicts("b")).toHaveLength(1);
      expect(store.getConflicts("a")[0]?.memoryKey).toBe("a");
      store.close();
    });

    test("re-saving the exact same value at a lower trust is still a rejected conflict — it can't silently downgrade the record's trust rank", () => {
      const store = new MemoryStore(":memory:");
      store.save({ key: "user.name", value: "David", source: "USER_STATED" });
      const resave = store.save({ key: "user.name", value: "David", source: "MODEL_INFERRED" });

      expect(resave.conflict).toBe(true);
      expect(resave.source).toBe("USER_STATED");
      store.close();
    });

    test("a same-value lower-trust resave cannot be used to soften up a record for a later real downgrade", () => {
      const store = new MemoryStore(":memory:");
      store.save({ key: "user.name", value: "David", source: "USER_STATED" });
      store.save({ key: "user.name", value: "David", source: "MODEL_INFERRED" }); // rejected, must not downgrade `source`

      const attempt = store.save({ key: "user.name", value: "Dave (a guess)", source: "MODEL_INFERRED" });

      expect(attempt.conflict).toBe(true);
      expect(store.getByKey("user.name")?.value).toBe("David");
      store.close();
    });

    test("saving the exact same value at equal or higher trust is never a conflict", () => {
      const store = new MemoryStore(":memory:");
      store.save({ key: "user.name", value: "David", source: "USER_STATED" });
      const resave = store.save({ key: "user.name", value: "David", source: "USER_STATED" });

      expect(resave.conflict).toBeFalsy();
      store.close();
    });
  });

  describe("Performance — bounded queries (Phase 48)", () => {
    test("search() with an empty fragment ('list everything') is bounded by a default limit, not the whole table", () => {
      const store = new MemoryStore(":memory:");
      for (let i = 0; i < 10; i++) {
        store.save({ key: `fact.${i}`, value: `value ${i}` });
      }

      const results = store.search("", 5);
      expect(results).toHaveLength(5);
      store.close();
    });

    test("search() still returns everything that matches when under the limit", () => {
      const store = new MemoryStore(":memory:");
      store.save({ key: "user.name", value: "David" });
      store.save({ key: "user.email", value: "dp@example.com" });

      expect(store.search("user.")).toHaveLength(2);
      store.close();
    });

    test("search() defaults to a bounded limit even when not passed explicitly", () => {
      const store = new MemoryStore(":memory:");
      for (let i = 0; i < 250; i++) {
        store.save({ key: `fact.${i}`, value: `value ${i}` });
      }

      // Default limit (200) caps the result even for a query matching every row.
      const results = store.search("");
      expect(results.length).toBeLessThanOrEqual(200);
      expect(results.length).toBeGreaterThan(0);
      store.close();
    });

    test("getActive() is bounded by a limit, newest first", () => {
      const store = new MemoryStore(":memory:");
      for (let i = 0; i < 10; i++) {
        store.save({ key: `fact.${i}`, value: `value ${i}` });
      }

      const results = store.getActive(new Date().toISOString(), 3);
      expect(results).toHaveLength(3);
      store.close();
    });
  });

  describe("searchSemantic (additive, opt-in — MemoryStore itself never computes embeddings)", () => {
    test("returns nothing when no memory has a stored embedding", () => {
      const store = new MemoryStore(":memory:");
      store.save({ key: "user.name", value: "David" });

      expect(store.searchSemantic([1, 0, 0])).toEqual([]);
      store.close();
    });

    test("finds a memory whose stored embedding is similar, even with no word overlap", () => {
      const store = new MemoryStore(":memory:");
      // "dentist" query embedding vs. a memory about "Dr. Cohen" with a
      // similar (but not identical) embedding direction — the whole point
      // of semantic search over exact LIKE matching.
      store.save({ key: "appointments.dentist", value: "appointment with Dr. Cohen", embedding: [1, 0.1, 0] });
      store.save({ key: "user.favorite_color", value: "blue", embedding: [0, 0, 1] });

      const results = store.searchSemantic([1, 0, 0]);
      expect(results).toHaveLength(1);
      expect(results[0]?.key).toBe("appointments.dentist");
      expect(results[0]?.similarity).toBeGreaterThan(0.5);
    });

    test("excludes memories below the similarity threshold", () => {
      const store = new MemoryStore(":memory:");
      store.save({ key: "a", value: "a", embedding: [1, 0] });
      store.save({ key: "b", value: "b", embedding: [0, 1] }); // orthogonal -> similarity 0

      const results = store.searchSemantic([1, 0]);
      expect(results.map((r) => r.key)).toEqual(["a"]);
    });

    test("skips memories with a mismatched embedding dimensionality rather than crashing", () => {
      const store = new MemoryStore(":memory:");
      store.save({ key: "a", value: "a", embedding: [1, 0, 0] });
      store.save({ key: "b", value: "b", embedding: [1, 0] }); // different length than the query

      const results = store.searchSemantic([1, 0, 0]);
      expect(results.map((r) => r.key)).toEqual(["a"]);
    });

    test("excludes expired memories", () => {
      const store = new MemoryStore(":memory:");
      store.save({
        key: "expired",
        value: "old",
        embedding: [1, 0],
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      });

      expect(store.searchSemantic([1, 0])).toEqual([]);
      store.close();
    });

    test("results are sorted most-similar first and bounded by limit", () => {
      const store = new MemoryStore(":memory:");
      store.save({ key: "close", value: "close", embedding: [1, 0.05] });
      store.save({ key: "closer", value: "closer", embedding: [1, 0] });

      const results = store.searchSemantic([1, 0], 1);
      expect(results).toHaveLength(1);
      expect(results[0]?.key).toBe("closer");
    });

    test("save() with embedding: undefined never touches an existing stored embedding", () => {
      const store = new MemoryStore(":memory:");
      store.save({ key: "k", value: "v1", embedding: [1, 0] });
      store.save({ key: "k", value: "v2" }); // no embedding field at all — same as every pre-existing caller

      const results = store.searchSemantic([1, 0]);
      expect(results.map((r) => r.value)).toEqual(["v2"]);
      store.close();
    });

    test("save() with an explicit null embedding clears a previously-stored one", () => {
      const store = new MemoryStore(":memory:");
      store.save({ key: "k", value: "v1", embedding: [1, 0] });
      store.save({ key: "k", value: "v2", embedding: null });

      expect(store.searchSemantic([1, 0])).toEqual([]);
      store.close();
    });
  });
});
