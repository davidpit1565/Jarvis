import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CreateReminderInput, ReminderRecord, ReminderRecurrence } from "@/types/reminders";

const RECURRENCE_DAYS: Record<ReminderRecurrence, number> = {
  daily: 1,
  weekly: 7,
};

/** y/m/d/h/m/s as displayed in `timeZone` for a given instant. */
function getZonedParts(
  date: Date,
  timeZone: string
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  // Some environments report midnight as hour 24 under h23 — normalize it.
  const hour = get("hour") % 24;
  return { year: get("year"), month: get("month"), day: get("day"), hour, minute: get("minute"), second: get("second") };
}

/**
 * Adds `days` calendar days to `isoDate`'s wall-clock time *as displayed in
 * `timeZone`*, keeping the same local hour/minute/second, and returns the
 * resulting UTC instant. Plain `new Date(x).getTime() + N * 86_400_000` is
 * wrong across a DST transition: adding exactly 24 (or 168) hours in UTC
 * doesn't land on the same local wall-clock time once the zone's offset has
 * shifted, so a daily/weekly reminder due at "9am" would silently drift to
 * 8am or 10am local the day it crosses a transition. This instead:
 *  1. reads the local y/m/d/h/m/s of `isoDate` in `timeZone`,
 *  2. adds `days` to the day field (JS's own Date normalizes month/year
 *     rollover for us — no calendar math needed here),
 *  3. finds the actual UTC instant whose local time in `timeZone` matches
 *     that target wall-clock time, via a short fixed-point iteration (the
 *     zone's UTC offset can only depend on which side of a transition the
 *     final answer falls on, so this converges in at most a couple of
 *     passes — no external timezone library needed for that).
 */
function addCalendarDaysInTimezone(isoDate: string, days: number, timeZone: string): string {
  const parts = getZonedParts(new Date(isoDate), timeZone);
  // A "neutral" UTC timestamp that merely encodes the target wall-clock
  // date/time — not the real answer yet, just a value to iterate from.
  const targetWallAsUtcMs = Date.UTC(parts.year, parts.month - 1, parts.day + days, parts.hour, parts.minute, parts.second);

  let guessMs = targetWallAsUtcMs;
  for (let i = 0; i < 3; i++) {
    const guessedParts = getZonedParts(new Date(guessMs), timeZone);
    const guessedWallAsUtcMs = Date.UTC(
      guessedParts.year,
      guessedParts.month - 1,
      guessedParts.day,
      guessedParts.hour,
      guessedParts.minute,
      guessedParts.second
    );
    const errorMs = targetWallAsUtcMs - guessedWallAsUtcMs;
    if (errorMs === 0) break;
    guessMs += errorMs;
  }

  return new Date(guessMs).toISOString();
}

/**
 * Local reminders/tasks store backed by SQLite, alongside (not merged
 * into) MemoryStore — a reminder is a distinct thing from a fact ("pick up
 * dry cleaning at 6pm" isn't a durable fact about the user, it's a task
 * with a lifecycle: pending -> completed). Separate table, separate file
 * by default, so one can be backed up/reset independently of the other.
 */
export class ReminderStore {
  private db: Database;
  private readonly timezone: string;

  /**
   * `timezone` (an IANA zone name, same as `JARVIS_TIMEZONE`) is what
   * `complete()` uses to advance a recurring reminder's next `dueAt` by
   * calendar days rather than fixed milliseconds — see
   * `addCalendarDaysInTimezone` above. Defaults to UTC, which has no DST
   * transitions, so existing callers that never pass it keep the exact
   * same (already-correct-for-UTC) behavior as before.
   */
  constructor(dbPath: string = ":memory:", timezone: string = "UTC") {
    this.timezone = timezone;
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    if (dbPath !== ":memory:") this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS reminders (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        due_at TEXT,
        completed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        recurrence TEXT
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_reminders_due_at ON reminders(due_at)`);

    // A database created before `recurrence`/`notified_at` existed won't
    // have the column — SQLite has no "ADD COLUMN IF NOT EXISTS," so this
    // just ignores the error when the column is already there.
    try {
      this.db.run(`ALTER TABLE reminders ADD COLUMN recurrence TEXT`);
    } catch {
      // already exists
    }
    try {
      this.db.run(`ALTER TABLE reminders ADD COLUMN notified_at TEXT`);
    } catch {
      // already exists
    }
  }

  create(input: CreateReminderInput): ReminderRecord {
    const record: ReminderRecord = {
      id: randomUUID(),
      text: input.text,
      // Canonicalized to UTC "Z" form rather than stored verbatim: due_at
      // is compared/sorted as raw TEXT elsewhere (the due_at index, ORDER
      // BY due_at, and getDueUnnotified's `r.dueAt <= nowIso`, where nowIso
      // is always a canonical toISOString()) — a valid-but-non-canonical
      // ISO string (e.g. a "+02:00" offset form instead of "Z") parses to
      // the correct instant but is NOT lexicographically comparable to a
      // "Z"-form timestamp, so an overdue reminder could silently never
      // fire (or sort out of order) depending on how its digits happen to
      // compare as plain text.
      dueAt: input.dueAt != null ? new Date(input.dueAt).toISOString() : null,
      completed: input.completed ?? false,
      createdAt: new Date().toISOString(),
      recurrence: input.recurrence ?? null,
      notifiedAt: null,
    };

    this.db
      .query(
        `INSERT INTO reminders (id, text, due_at, completed, created_at, recurrence, notified_at) VALUES (?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(record.id, record.text, record.dueAt, record.completed ? 1 : 0, record.createdAt, record.recurrence);

    return record;
  }

  /** Pending reminders by default (what "what do I need to do" should see); pass true to include completed ones too. */
  list(includeCompleted: boolean = false): ReminderRecord[] {
    const query = includeCompleted
      ? `SELECT id, text, due_at as dueAt, completed, created_at as createdAt, recurrence, notified_at as notifiedAt FROM reminders ORDER BY (due_at IS NULL), due_at ASC, created_at ASC`
      : `SELECT id, text, due_at as dueAt, completed, created_at as createdAt, recurrence, notified_at as notifiedAt FROM reminders WHERE completed = 0 ORDER BY (due_at IS NULL), due_at ASC, created_at ASC`;

    const rows = this.db.query(query).all() as Array<Omit<ReminderRecord, "completed"> & { completed: number }>;
    return rows.map((row) => ({ ...row, completed: row.completed === 1 }));
  }

  /**
   * A due, pending reminder JARVIS hasn't yet pushed a notification for —
   * the input to the scheduler in index.ts that actually sends one at the
   * right time, instead of the reminder only ever surfacing if the user
   * happens to talk to JARVIS again after it's due.
   */
  getDueUnnotified(nowIso: string): ReminderRecord[] {
    return this.list().filter((r) => r.dueAt !== null && r.dueAt <= nowIso && r.notifiedAt === null);
  }

  /** Records that a due-reminder push notification actually went out, so the scheduler doesn't send it again. */
  markNotified(id: string, nowIso: string): void {
    this.db.query(`UPDATE reminders SET notified_at = ? WHERE id = ?`).run(nowIso, id);
  }

  /**
   * Marks the reminder completed. When it has a recurrence and a dueAt,
   * this also creates the next occurrence (same text/recurrence, dueAt
   * advanced by one interval) — "remind me every day to take my
   * medication" keeps recurring instead of vanishing after the first
   * completion. A recurring reminder with no dueAt has nothing to
   * advance from, so it completes like a normal one-off.
   */
  complete(id: string): boolean {
    const existing = this.get(id);
    // AND completed = 0: SQLite's `changes` reflects rows the WHERE
    // clause matched, not rows whose value actually changed — without
    // this, re-completing an already-completed id would still report
    // changes === 1, and the recurrence-advance branch below would fire
    // again on every repeat call, creating a duplicate next-occurrence
    // reminder each time (which itself recurs, compounding the
    // duplication). Same idiom as CommitmentStore.markStale's
    // `WHERE id = ? AND status = 'open'`.
    const result = this.db.query(`UPDATE reminders SET completed = 1 WHERE id = ? AND completed = 0`).run(id);
    if (result.changes === 0) return false;

    if (existing?.recurrence && existing.dueAt) {
      const nextDueAt = addCalendarDaysInTimezone(existing.dueAt, RECURRENCE_DAYS[existing.recurrence], this.timezone);
      this.create({ text: existing.text, dueAt: nextDueAt, recurrence: existing.recurrence });
    }

    return true;
  }

  /** True delete — distinct from complete(): for a reminder that should never have existed, not one that was done. */
  delete(id: string): boolean {
    const result = this.db.query(`DELETE FROM reminders WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  /** Edits an existing reminder's text and/or due date — e.g. "actually make that 7pm" or fixing a typo. */
  update(
    id: string,
    changes: { text?: string; dueAt?: string | null; recurrence?: ReminderRecurrence | null }
  ): ReminderRecord | null {
    const existing = this.get(id);
    if (!existing) return null;

    const text = changes.text ?? existing.text;
    // Same UTC canonicalization as create() — see its comment.
    const dueAt =
      changes.dueAt !== undefined ? (changes.dueAt != null ? new Date(changes.dueAt).toISOString() : null) : existing.dueAt;
    const recurrence = changes.recurrence !== undefined ? changes.recurrence : existing.recurrence;
    // A re-dated reminder should get a fresh notification at its new
    // time, not stay silenced by one already sent for the old time.
    // Compared against the normalized `dueAt` (not the raw `changes.dueAt`)
    // so a re-supplied due time that's merely a different ISO spelling of
    // the same instant isn't mistaken for an actual change.
    const notifiedAt = changes.dueAt !== undefined && dueAt !== existing.dueAt ? null : existing.notifiedAt;

    this.db
      .query(`UPDATE reminders SET text = ?, due_at = ?, recurrence = ?, notified_at = ? WHERE id = ?`)
      .run(text, dueAt, recurrence, notifiedAt, id);
    return { ...existing, text, dueAt, recurrence, notifiedAt };
  }

  get(id: string): ReminderRecord | null {
    const row = this.db
      .query(
        `SELECT id, text, due_at as dueAt, completed, created_at as createdAt, recurrence, notified_at as notifiedAt FROM reminders WHERE id = ?`
      )
      .get(id) as (Omit<ReminderRecord, "completed"> & { completed: number }) | null;
    if (!row) return null;
    return { ...row, completed: row.completed === 1 };
  }

  close(): void {
    this.db.close();
  }
}
