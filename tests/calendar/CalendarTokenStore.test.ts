import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { CalendarTokenStore } from "@/calendar/CalendarTokenStore";

describe("CalendarTokenStore", () => {
  test("returns null and reports unlinked when nothing is saved", () => {
    const store = new CalendarTokenStore(":memory:");
    expect(store.get("me@example.com")).toBeNull();
    expect(store.isLinked("me@example.com")).toBe(false);
    expect(store.count()).toBe(0);
    expect(store.getAll()).toEqual([]);
    store.close();
  });

  test("saves and retrieves one account's tokens", () => {
    const store = new CalendarTokenStore(":memory:");
    store.save("me@example.com", { refreshToken: "refresh-1", accessToken: "access-1", accessTokenExpiresAt: 12345 });

    expect(store.isLinked("me@example.com")).toBe(true);
    const saved = store.get("me@example.com");
    expect(saved?.refreshToken).toBe("refresh-1");
    expect(saved?.accessToken).toBe("access-1");
    expect(saved?.accessTokenExpiresAt).toBe(12345);
    expect(saved?.email).toBe("me@example.com");
    store.close();
  });

  test("save for the SAME email replaces that account's tokens (re-linking/refreshing)", () => {
    const store = new CalendarTokenStore(":memory:");
    store.save("me@example.com", { refreshToken: "refresh-1", accessToken: "access-1", accessTokenExpiresAt: 111 });
    store.save("me@example.com", { refreshToken: "refresh-2", accessToken: "access-2", accessTokenExpiresAt: 222 });

    expect(store.get("me@example.com")?.refreshToken).toBe("refresh-2");
    expect(store.count()).toBe(1);
    store.close();
  });

  test("save for a DIFFERENT email is additive — the first account's tokens are untouched", () => {
    const store = new CalendarTokenStore(":memory:");
    store.save("work@example.com", { refreshToken: "work-refresh", accessToken: "work-access", accessTokenExpiresAt: 111 });
    store.save("personal@example.com", { refreshToken: "personal-refresh", accessToken: "personal-access", accessTokenExpiresAt: 222 });

    expect(store.count()).toBe(2);
    expect(store.get("work@example.com")?.refreshToken).toBe("work-refresh");
    expect(store.get("personal@example.com")?.refreshToken).toBe("personal-refresh");
    store.close();
  });

  test("getAll returns every linked account, oldest-linked (primary) first", () => {
    const store = new CalendarTokenStore(":memory:");
    store.save("first@example.com", { refreshToken: "r1", accessToken: "a1", accessTokenExpiresAt: 1 });
    store.save("second@example.com", { refreshToken: "r2", accessToken: "a2", accessTokenExpiresAt: 2 });
    store.save("third@example.com", { refreshToken: "r3", accessToken: "a3", accessTokenExpiresAt: 3 });

    expect(store.getAll().map((a) => a.email)).toEqual(["first@example.com", "second@example.com", "third@example.com"]);
    store.close();
  });

  test("re-linking (saving again) an account does not change its position in link order", () => {
    const store = new CalendarTokenStore(":memory:");
    store.save("first@example.com", { refreshToken: "r1", accessToken: "a1", accessTokenExpiresAt: 1 });
    store.save("second@example.com", { refreshToken: "r2", accessToken: "a2", accessTokenExpiresAt: 2 });
    // Re-link the first account — should stay first, not jump to last.
    store.save("first@example.com", { refreshToken: "r1-new", accessToken: "a1-new", accessTokenExpiresAt: 3 });

    expect(store.getAll().map((a) => a.email)).toEqual(["first@example.com", "second@example.com"]);
    expect(store.get("first@example.com")?.refreshToken).toBe("r1-new");
    store.close();
  });

  test("updateAccessToken leaves the refresh token untouched and only affects the given account", () => {
    const store = new CalendarTokenStore(":memory:");
    store.save("work@example.com", { refreshToken: "work-refresh", accessToken: "work-access", accessTokenExpiresAt: 111 });
    store.save("personal@example.com", { refreshToken: "personal-refresh", accessToken: "personal-access", accessTokenExpiresAt: 111 });

    store.updateAccessToken("work@example.com", "work-access-2", 999);

    expect(store.get("work@example.com")).toMatchObject({ refreshToken: "work-refresh", accessToken: "work-access-2", accessTokenExpiresAt: 999 });
    expect(store.get("personal@example.com")).toMatchObject({ refreshToken: "personal-refresh", accessToken: "personal-access" });
    store.close();
  });

  test("delete unlinks one account without touching another", () => {
    const store = new CalendarTokenStore(":memory:");
    store.save("work@example.com", { refreshToken: "r1", accessToken: "a1", accessTokenExpiresAt: 111 });
    store.save("personal@example.com", { refreshToken: "r2", accessToken: "a2", accessTokenExpiresAt: 222 });

    store.delete("work@example.com");

    expect(store.isLinked("work@example.com")).toBe(false);
    expect(store.isLinked("personal@example.com")).toBe(true);
    expect(store.count()).toBe(1);
    store.close();
  });

  test("email lookups are case-insensitive — a linked account is found regardless of how the caller cases the address", () => {
    const store = new CalendarTokenStore(":memory:");
    store.save("Alice@Gmail.com", { refreshToken: "r1", accessToken: "a1", accessTokenExpiresAt: 111 });

    // Stored normalized to lowercase, findable by any casing.
    expect(store.get("Alice@Gmail.com")?.email).toBe("alice@gmail.com");
    expect(store.get("alice@gmail.com")?.refreshToken).toBe("r1");
    expect(store.get("ALICE@GMAIL.COM")?.refreshToken).toBe("r1");
    expect(store.isLinked("Alice@Gmail.com")).toBe(true);
    expect(store.count()).toBe(1);
    store.close();
  });

  test("saving the same email under different casing updates the same row rather than creating a duplicate", () => {
    const store = new CalendarTokenStore(":memory:");
    store.save("alice@gmail.com", { refreshToken: "r1", accessToken: "a1", accessTokenExpiresAt: 111 });
    store.save("Alice@Gmail.com", { refreshToken: "r2", accessToken: "a2", accessTokenExpiresAt: 222 });

    expect(store.count()).toBe(1);
    expect(store.get("alice@gmail.com")?.refreshToken).toBe("r2");
    store.close();
  });

  test("updateAccessToken and delete also match regardless of casing", () => {
    const store = new CalendarTokenStore(":memory:");
    store.save("alice@gmail.com", { refreshToken: "r1", accessToken: "a1", accessTokenExpiresAt: 111 });

    store.updateAccessToken("Alice@Gmail.com", "a1-new", 999);
    expect(store.get("alice@gmail.com")?.accessToken).toBe("a1-new");

    store.delete("ALICE@GMAIL.COM");
    expect(store.isLinked("alice@gmail.com")).toBe(false);
    store.close();
  });

  test("survives across instances backed by the same SQLite file", () => {
    const dbPath = `/tmp/jarvis-calendar-token-test-${crypto.randomUUID()}.sqlite`;

    const first = new CalendarTokenStore(dbPath);
    first.save("me@example.com", { refreshToken: "refresh-1", accessToken: "access-1", accessTokenExpiresAt: 111 });
    first.close();

    const second = new CalendarTokenStore(dbPath);
    expect(second.get("me@example.com")?.refreshToken).toBe("refresh-1");
    second.close();
  });

  describe("migration from the old single-account schema", () => {
    /** Recreates the OLD schema (id TEXT PRIMARY KEY, fixed at "google") directly against a raw Database, bypassing CalendarTokenStore entirely — simulating a pre-existing installation's SQLite file before this pass. */
    function seedLegacyDatabase(dbPath: string, tokens: { refreshToken: string; accessToken: string; accessTokenExpiresAt: number }): void {
      const raw = new Database(dbPath);
      raw.run(`
        CREATE TABLE calendar_tokens (
          id TEXT PRIMARY KEY,
          refresh_token TEXT NOT NULL,
          access_token TEXT,
          access_token_expires_at INTEGER
        )
      `);
      raw.query(`INSERT INTO calendar_tokens (id, refresh_token, access_token, access_token_expires_at) VALUES ('google', ?, ?, ?)`).run(
        tokens.refreshToken,
        tokens.accessToken,
        tokens.accessTokenExpiresAt
      );
      raw.close();
    }

    test("carries a pre-existing legacy row forward, under the placeholder key, instead of dropping it", () => {
      const dbPath = `/tmp/jarvis-calendar-token-migration-${crypto.randomUUID()}.sqlite`;
      seedLegacyDatabase(dbPath, { refreshToken: "legacy-refresh", accessToken: "legacy-access", accessTokenExpiresAt: 555 });

      const store = new CalendarTokenStore(dbPath);

      expect(store.count()).toBe(1);
      const needsBackfill = store.listAccountsNeedingEmailBackfill();
      expect(needsBackfill).toHaveLength(1);
      expect(needsBackfill[0]?.refreshToken).toBe("legacy-refresh");
      expect(needsBackfill[0]?.accessToken).toBe("legacy-access");
      expect(needsBackfill[0]?.accessTokenExpiresAt).toBe(555);
      // Not a real email yet — that's the whole point of needing backfill.
      expect(needsBackfill[0]?.email).not.toContain("@");
      store.close();
    });

    test("rekey moves the migrated row onto its real, now-fetched email, preserving its tokens and link order", () => {
      const dbPath = `/tmp/jarvis-calendar-token-migration-${crypto.randomUUID()}.sqlite`;
      seedLegacyDatabase(dbPath, { refreshToken: "legacy-refresh", accessToken: "legacy-access", accessTokenExpiresAt: 555 });

      const store = new CalendarTokenStore(dbPath);
      const [legacy] = store.listAccountsNeedingEmailBackfill();
      store.rekey(legacy!.email, "real-owner@example.com");

      expect(store.listAccountsNeedingEmailBackfill()).toEqual([]);
      expect(store.isLinked("real-owner@example.com")).toBe(true);
      const rekeyed = store.get("real-owner@example.com");
      expect(rekeyed?.refreshToken).toBe("legacy-refresh");
      expect(rekeyed?.accessToken).toBe("legacy-access");
      expect(rekeyed?.accessTokenExpiresAt).toBe(555);
      store.close();
    });

    test("migration is idempotent — reopening an already-migrated database doesn't touch it again", () => {
      const dbPath = `/tmp/jarvis-calendar-token-migration-${crypto.randomUUID()}.sqlite`;
      seedLegacyDatabase(dbPath, { refreshToken: "legacy-refresh", accessToken: "legacy-access", accessTokenExpiresAt: 555 });

      const first = new CalendarTokenStore(dbPath);
      const [legacy] = first.listAccountsNeedingEmailBackfill();
      first.rekey(legacy!.email, "real-owner@example.com");
      first.close();

      // Re-opening the now-already-migrated (and backfilled) database
      // must not rename/duplicate/lose anything.
      const second = new CalendarTokenStore(dbPath);
      expect(second.count()).toBe(1);
      expect(second.isLinked("real-owner@example.com")).toBe(true);
      expect(second.listAccountsNeedingEmailBackfill()).toEqual([]);
      second.close();
    });

    test("a brand-new database (no legacy table at all) is unaffected by the migration path", () => {
      const store = new CalendarTokenStore(":memory:");
      expect(store.count()).toBe(0);
      expect(store.listAccountsNeedingEmailBackfill()).toEqual([]);
      store.save("me@example.com", { refreshToken: "r1", accessToken: "a1", accessTokenExpiresAt: 1 });
      expect(store.count()).toBe(1);
      store.close();
    });
  });
});
