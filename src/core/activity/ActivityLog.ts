import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** "thinking"/"speaking" drive the dashboard's live ticker and hologram glow; "info" is everything else (device/tool events). */
export type ActivityKind = "info" | "thinking" | "speaking";

export interface ActivityEntry {
  timestamp: string;
  message: string;
  kind: ActivityKind;
}

const MAX_ENTRIES = 30;
/** Rows kept in the optional SQLite backing store — more than the in-memory ring buffer surfaces, so a restart still has real history to reload from. */
const MAX_PERSISTED_ROWS = 500;

/**
 * A small in-memory ring buffer of recent, human-readable activity —
 * feeds the dashboard's "Activity" panel and live ticker. Optionally
 * backed by SQLite (pass a dbPath) so that history survives a restart —
 * without it, a redeploy on Fly.io would otherwise reset the dashboard to
 * "Nothing yet." even though JARVIS has been running for weeks. The
 * eventBus itself remains the source of truth for anything needing full
 * fidelity; this is a durable *summary* for display, not a full audit log.
 */
export class ActivityLog {
  private entries: ActivityEntry[] = [];
  private db: Database | null = null;

  constructor(dbPath?: string) {
    if (!dbPath || dbPath === ":memory:") return;

    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        message TEXT NOT NULL,
        kind TEXT NOT NULL
      )
    `);

    const rows = this.db
      .query(`SELECT timestamp, message, kind FROM activity_log ORDER BY id DESC LIMIT ?`)
      .all(MAX_ENTRIES) as ActivityEntry[];
    this.entries = rows;
  }

  record(message: string, kind: ActivityKind = "info"): void {
    const entry: ActivityEntry = { timestamp: new Date().toISOString(), message, kind };
    this.entries.unshift(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.length = MAX_ENTRIES;
    }

    if (this.db) {
      this.db
        .query(`INSERT INTO activity_log (timestamp, message, kind) VALUES (?, ?, ?)`)
        .run(entry.timestamp, entry.message, entry.kind);
      // Keep the backing table bounded — this is a display summary, not an
      // unbounded audit log, so old rows beyond MAX_PERSISTED_ROWS are
      // pruned rather than left to grow the database file forever.
      this.db.run(
        `DELETE FROM activity_log WHERE id NOT IN (SELECT id FROM activity_log ORDER BY id DESC LIMIT ${MAX_PERSISTED_ROWS})`
      );
    }
  }

  list(): ActivityEntry[] {
    return [...this.entries];
  }

  close(): void {
    this.db?.close();
  }
}
