import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

export interface DbIntegrityResult {
  path: string;
  ok: boolean;
  /** SQLite's own `PRAGMA integrity_check` output ("ok" on success), or the caught error message when the file couldn't even be opened as a database. */
  detail: string;
}

/**
 * Actually opens each database file `createBackupArchive` is about to
 * back up and runs SQLite's own `PRAGMA integrity_check` against it,
 * instead of trusting that the file being present and copyable means
 * it's a valid, restorable database — see JARVIS_ROADMAP_AUDIT.md #164.
 * A half-written page or a truncated copy would previously have been
 * backed up and declared fine; this actually opens it read-only first.
 *
 * Missing paths are silently skipped (same reasoning as
 * `createBackupArchive` itself: a feature that was never configured
 * never created its db file, and that's not a corruption). Opened
 * read-only — this never mutates the live databases it's checking.
 */
export function verifyDatabaseIntegrity(dbPaths: string[]): DbIntegrityResult[] {
  const results: DbIntegrityResult[] = [];

  for (const path of dbPaths) {
    if (!existsSync(path)) continue;

    try {
      const db = new Database(path, { readonly: true });
      try {
        const row = db.query("PRAGMA integrity_check").get() as Record<string, unknown> | undefined;
        const detail = row ? String(Object.values(row)[0]) : "no result";
        results.push({ path, ok: detail === "ok", detail });
      } finally {
        db.close();
      }
    } catch (error) {
      results.push({ path, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }

  return results;
}
