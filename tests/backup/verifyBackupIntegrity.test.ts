import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { writeFileSync, unlinkSync } from "node:fs";
import { verifyDatabaseIntegrity } from "@/backup/verifyBackupIntegrity";

describe("verifyDatabaseIntegrity", () => {
  test("skips paths that don't exist", () => {
    const results = verifyDatabaseIntegrity(["/tmp/jarvis-integrity-test-does-not-exist.sqlite"]);
    expect(results).toEqual([]);
  });

  test("reports ok for a real, healthy SQLite database", () => {
    const path = `/tmp/jarvis-integrity-test-${crypto.randomUUID()}.sqlite`;
    const db = new Database(path);
    db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, value TEXT)");
    db.run("INSERT INTO t (value) VALUES ('hello')");
    db.close();

    try {
      const results = verifyDatabaseIntegrity([path]);
      expect(results).toHaveLength(1);
      expect(results[0]!.path).toBe(path);
      expect(results[0]!.ok).toBe(true);
      expect(results[0]!.detail).toBe("ok");
    } finally {
      unlinkSync(path);
    }
  });

  test("reports failure for a deliberately corrupted / non-SQLite file", () => {
    const path = `/tmp/jarvis-integrity-test-corrupt-${crypto.randomUUID()}.sqlite`;
    // Not a valid SQLite file at all — no header, no page structure.
    writeFileSync(path, "this is definitely not a sqlite database file, just garbage bytes");

    try {
      const results = verifyDatabaseIntegrity([path]);
      expect(results).toHaveLength(1);
      expect(results[0]!.ok).toBe(false);
      expect(results[0]!.detail).not.toBe("ok");
    } finally {
      unlinkSync(path);
    }
  });

  test("checks every existing path independently, one bad file doesn't hide a good one", () => {
    const goodPath = `/tmp/jarvis-integrity-test-good-${crypto.randomUUID()}.sqlite`;
    const badPath = `/tmp/jarvis-integrity-test-bad-${crypto.randomUUID()}.sqlite`;
    const db = new Database(goodPath);
    db.run("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    db.close();
    writeFileSync(badPath, "garbage");

    try {
      const results = verifyDatabaseIntegrity([goodPath, badPath, "/tmp/jarvis-integrity-missing.sqlite"]);
      expect(results).toHaveLength(2);
      const byPath = Object.fromEntries(results.map((r) => [r.path, r]));
      expect(byPath[goodPath]!.ok).toBe(true);
      expect(byPath[badPath]!.ok).toBe(false);
    } finally {
      unlinkSync(goodPath);
      unlinkSync(badPath);
    }
  });
});
