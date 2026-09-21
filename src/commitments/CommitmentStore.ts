import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CommitmentRecord, CommitmentStatus, CreateCommitmentInput } from "@/types/commitments";

/**
 * Local commitment/promise-tracking store, same SQLite house style as
 * ReminderStore — but a distinct concept: a commitment is something
 * JARVIS or the user said would happen ("I'll follow up with you
 * tomorrow", "remind me to check on this next week") without a precise
 * due time, as opposed to a formal CREATE_REMINDER with a real `dueAt`.
 * Kept as its own table/store rather than folded into ReminderStore so
 * "soft follow-up" and "scheduled task" stay conceptually (and
 * query-wise) separate — a stale commitment surfaces as a nudge to
 * follow up, not as an overdue task.
 */
export class CommitmentStore {
  private db: Database;

  constructor(dbPath: string = ":memory:") {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    if (dbPath !== ":memory:") this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS commitments (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        due_context TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        fulfilled_at TEXT
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_commitments_status ON commitments(status)`);

    // Same best-effort ALTER TABLE pattern as ReminderStore/AutomationRuleStore
    // — safe to run against a database that already has these columns.
    try {
      this.db.run(`ALTER TABLE commitments ADD COLUMN fulfilled_at TEXT`);
    } catch {
      // already exists
    }
  }

  create(input: CreateCommitmentInput): CommitmentRecord {
    const record: CommitmentRecord = {
      id: randomUUID(),
      text: input.text,
      dueContext: input.dueContext ?? null,
      status: "open",
      createdAt: new Date().toISOString(),
      fulfilledAt: null,
    };

    this.db
      .query(
        `INSERT INTO commitments (id, text, due_context, status, created_at, fulfilled_at) VALUES (?, ?, ?, 'open', ?, NULL)`
      )
      .run(record.id, record.text, record.dueContext, record.createdAt);

    return record;
  }

  /** All commitments, newest first, optionally filtered to one status ("open"/"fulfilled"/"stale"). */
  list(status?: CommitmentStatus): CommitmentRecord[] {
    // Tie-broken by rowid DESC, not just created_at DESC: two commitments
    // created within the same millisecond (created_at has no finer
    // resolution) would otherwise sort in an unspecified order instead of
    // reliably newest-inserted-first.
    const query = status
      ? `SELECT id, text, due_context as dueContext, status, created_at as createdAt, fulfilled_at as fulfilledAt
         FROM commitments WHERE status = ? ORDER BY created_at DESC, rowid DESC`
      : `SELECT id, text, due_context as dueContext, status, created_at as createdAt, fulfilled_at as fulfilledAt
         FROM commitments ORDER BY created_at DESC, rowid DESC`;

    const rows = status
      ? (this.db.query(query).all(status) as CommitmentRecord[])
      : (this.db.query(query).all() as CommitmentRecord[]);
    return rows;
  }

  get(id: string): CommitmentRecord | null {
    const row = this.db
      .query(
        `SELECT id, text, due_context as dueContext, status, created_at as createdAt, fulfilled_at as fulfilledAt
         FROM commitments WHERE id = ?`
      )
      .get(id) as CommitmentRecord | null;
    return row ?? null;
  }

  /** Marks a commitment fulfilled — "I already did that" / "already followed up". */
  fulfill(id: string, nowIso: string = new Date().toISOString()): boolean {
    const result = this.db
      .query(`UPDATE commitments SET status = 'fulfilled', fulfilled_at = ? WHERE id = ?`)
      .run(nowIso, id);
    return result.changes > 0;
  }

  /**
   * Transitions an open commitment to "stale" — used by the follow-up
   * engine's scheduled check (getStaleCommitments) once a commitment has
   * been open longer than the configured threshold. A no-op (returns
   * false) for a commitment that's already fulfilled/stale or doesn't
   * exist, so the caller's in-flight-id guard is the only double-fire
   * protection actually needed.
   */
  markStale(id: string): boolean {
    const result = this.db.query(`UPDATE commitments SET status = 'stale' WHERE id = ? AND status = 'open'`).run(id);
    return result.changes > 0;
  }

  delete(id: string): boolean {
    const result = this.db.query(`DELETE FROM commitments WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
