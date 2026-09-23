import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CreateWakeUpCallInput, WakeUpCallRecord } from "@/types/wakeUpCalls";

const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidTimeOfDay(value: string): boolean {
  return TIME_OF_DAY_PATTERN.test(value);
}

/**
 * Recurring daily wake-up call schedule — distinct from ReminderStore's
 * one-off due dates: a wake-up call repeats every day at the same
 * wall-clock time until deleted or disabled, and it's a phone call JARVIS
 * itself places, not a reminder surfaced in conversation.
 */
export class WakeUpCallStore {
  private db: Database;

  constructor(dbPath: string = ":memory:") {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    if (dbPath !== ":memory:") this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS wakeup_calls (
        id TEXT PRIMARY KEY,
        time_of_day TEXT NOT NULL,
        label TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_triggered_date TEXT,
        created_at TEXT NOT NULL
      )
    `);
  }

  create(input: CreateWakeUpCallInput): WakeUpCallRecord {
    if (!isValidTimeOfDay(input.timeOfDay)) {
      throw new Error(`Invalid timeOfDay: "${input.timeOfDay}" — expected 24-hour HH:MM`);
    }

    const record: WakeUpCallRecord = {
      id: randomUUID(),
      timeOfDay: input.timeOfDay,
      label: input.label ?? null,
      enabled: true,
      lastTriggeredDate: null,
      createdAt: new Date().toISOString(),
    };

    this.db
      .query(`INSERT INTO wakeup_calls (id, time_of_day, label, enabled, last_triggered_date, created_at) VALUES (?, ?, ?, 1, NULL, ?)`)
      .run(record.id, record.timeOfDay, record.label, record.createdAt);

    return record;
  }

  list(): WakeUpCallRecord[] {
    const rows = this.db
      .query(
        `SELECT id, time_of_day as timeOfDay, label, enabled, last_triggered_date as lastTriggeredDate, created_at as createdAt
         FROM wakeup_calls ORDER BY time_of_day ASC`
      )
      .all() as Array<Omit<WakeUpCallRecord, "enabled"> & { enabled: number }>;
    return rows.map((row) => ({ ...row, enabled: row.enabled === 1 }));
  }

  delete(id: string): boolean {
    const result = this.db.query(`DELETE FROM wakeup_calls WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  private getById(id: string): WakeUpCallRecord | null {
    const row = this.db
      .query(
        `SELECT id, time_of_day as timeOfDay, label, enabled, last_triggered_date as lastTriggeredDate, created_at as createdAt
         FROM wakeup_calls WHERE id = ?`
      )
      .get(id) as (Omit<WakeUpCallRecord, "enabled"> & { enabled: number }) | null;
    return row ? { ...row, enabled: row.enabled === 1 } : null;
  }

  /**
   * Edits an existing wake-up call's time of day and/or label in place —
   * e.g. "actually wake me up at 8 instead". Without this, changing
   * anything meant delete-then-recreate, which loses lastTriggeredDate
   * for no reason (so the call could fire again today right after being
   * "changed" for later today).
   */
  update(id: string, changes: { timeOfDay?: string; label?: string | null; enabled?: boolean }): WakeUpCallRecord | null {
    const existing = this.getById(id);
    if (!existing) return null;

    if (changes.timeOfDay !== undefined && !isValidTimeOfDay(changes.timeOfDay)) {
      throw new Error(`Invalid timeOfDay: "${changes.timeOfDay}" — expected 24-hour HH:MM`);
    }

    const timeOfDay = changes.timeOfDay ?? existing.timeOfDay;
    const label = changes.label !== undefined ? changes.label : existing.label;
    const enabled = changes.enabled !== undefined ? changes.enabled : existing.enabled;
    // Changing the actual scheduled time means today's earlier firing (if
    // any) was under the OLD time — it says nothing about whether the call
    // has gone out at the new time yet, so it must be allowed to fire today too.
    const lastTriggeredDate = timeOfDay === existing.timeOfDay ? existing.lastTriggeredDate : null;

    this.db
      .query(`UPDATE wakeup_calls SET time_of_day = ?, label = ?, enabled = ?, last_triggered_date = ? WHERE id = ?`)
      .run(timeOfDay, label, enabled ? 1 : 0, lastTriggeredDate, id);
    return { ...existing, timeOfDay, label, enabled, lastTriggeredDate };
  }

  /** Records that this call actually went out today, so the scheduler doesn't fire it again until tomorrow. */
  markTriggered(id: string, dateStr: string): void {
    this.db.query(`UPDATE wakeup_calls SET last_triggered_date = ? WHERE id = ?`).run(dateStr, id);
  }

  close(): void {
    this.db.close();
  }
}
