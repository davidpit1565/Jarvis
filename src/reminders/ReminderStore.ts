import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CreateReminderInput, ReminderRecord } from "@/types/reminders";

/**
 * Local reminders/tasks store backed by SQLite, alongside (not merged
 * into) MemoryStore — a reminder is a distinct thing from a fact ("pick up
 * dry cleaning at 6pm" isn't a durable fact about the user, it's a task
 * with a lifecycle: pending -> completed). Separate table, separate file
 * by default, so one can be backed up/reset independently of the other.
 */
export class ReminderStore {
  private db: Database;

  constructor(dbPath: string = ":memory:") {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS reminders (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        due_at TEXT,
        completed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_reminders_due_at ON reminders(due_at)`);
  }

  create(input: CreateReminderInput): ReminderRecord {
    const record: ReminderRecord = {
      id: randomUUID(),
      text: input.text,
      dueAt: input.dueAt ?? null,
      completed: false,
      createdAt: new Date().toISOString(),
    };

    this.db
      .query(`INSERT INTO reminders (id, text, due_at, completed, created_at) VALUES (?, ?, ?, 0, ?)`)
      .run(record.id, record.text, record.dueAt, record.createdAt);

    return record;
  }

  /** Pending reminders by default (what "what do I need to do" should see); pass true to include completed ones too. */
  list(includeCompleted: boolean = false): ReminderRecord[] {
    const query = includeCompleted
      ? `SELECT id, text, due_at as dueAt, completed, created_at as createdAt FROM reminders ORDER BY (due_at IS NULL), due_at ASC, created_at ASC`
      : `SELECT id, text, due_at as dueAt, completed, created_at as createdAt FROM reminders WHERE completed = 0 ORDER BY (due_at IS NULL), due_at ASC, created_at ASC`;

    const rows = this.db.query(query).all() as Array<Omit<ReminderRecord, "completed"> & { completed: number }>;
    return rows.map((row) => ({ ...row, completed: row.completed === 1 }));
  }

  complete(id: string): boolean {
    const result = this.db.query(`UPDATE reminders SET completed = 1 WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  /** True delete — distinct from complete(): for a reminder that should never have existed, not one that was done. */
  delete(id: string): boolean {
    const result = this.db.query(`DELETE FROM reminders WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  /** Edits an existing reminder's text and/or due date — e.g. "actually make that 7pm" or fixing a typo. */
  update(id: string, changes: { text?: string; dueAt?: string | null }): ReminderRecord | null {
    const existing = this.get(id);
    if (!existing) return null;

    const text = changes.text ?? existing.text;
    const dueAt = changes.dueAt !== undefined ? changes.dueAt : existing.dueAt;

    this.db.query(`UPDATE reminders SET text = ?, due_at = ? WHERE id = ?`).run(text, dueAt, id);
    return { ...existing, text, dueAt };
  }

  get(id: string): ReminderRecord | null {
    const row = this.db
      .query(`SELECT id, text, due_at as dueAt, completed, created_at as createdAt FROM reminders WHERE id = ?`)
      .get(id) as (Omit<ReminderRecord, "completed"> & { completed: number }) | null;
    if (!row) return null;
    return { ...row, completed: row.completed === 1 };
  }

  close(): void {
    this.db.close();
  }
}
