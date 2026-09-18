import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Streams a gzip'd tar of every existing SQLite database file — the only
 * way to actually recover from a lost/corrupted volume, since nothing
 * else in this project ever copies these files anywhere else. Missing
 * paths (e.g. a feature that was never configured, so its DB was never
 * created) are silently skipped rather than failing the whole backup.
 *
 * This is a best-effort file copy, not a hot backup: a write landing
 * mid-copy could in theory be captured half-written. Acceptable here
 * since JARVIS has no multi-writer contention and an admin triggers this
 * manually, not on every write.
 */
export function createBackupArchive(dbPaths: string[]): Response {
  const existingPaths = dbPaths.filter((p) => existsSync(p)).map((p) => resolve(p));

  if (existingPaths.length === 0) {
    return Response.json({ error: "No database files found to back up" }, { status: 404 });
  }

  const proc = Bun.spawn(["tar", "-czf", "-", ...existingPaths], { stdout: "pipe" });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

  return new Response(proc.stdout, {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="jarvis-backup-${timestamp}.tar.gz"`,
    },
  });
}
