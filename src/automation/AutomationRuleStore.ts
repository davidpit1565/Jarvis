import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AutomationRuleRecord, CreateAutomationRuleInput } from "@/types/automationRules";
import { isValidTimeOfDay } from "@/wakeup/WakeUpCallStore";

const MAX_INSTRUCTION_LENGTH = 2000;

/**
 * Recurring daily automation rule — the "JARVIS acts on its own by
 * rules" feature. Distinct from WakeUpCallStore (always places a phone
 * call) and ReminderStore (surfaced passively in conversation): a rule
 * fires by actually running its instruction through the same
 * Orchestrator every other message goes through, at the same wall-clock
 * time every day until deleted or disabled, with the reply pushed to the
 * user (see the scheduler in index.ts). Every existing tool-permission
 * check still applies to what a rule's instruction can do — a rule is
 * just a way to trigger a conversation turn on a timer, not a bypass.
 */
export class AutomationRuleStore {
  private db: Database;

  constructor(dbPath: string = ":memory:") {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    if (dbPath !== ":memory:") this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS automation_rules (
        id TEXT PRIMARY KEY,
        time_of_day TEXT NOT NULL,
        instruction TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_triggered_date TEXT,
        created_at TEXT NOT NULL
      )
    `);
  }

  create(input: CreateAutomationRuleInput): AutomationRuleRecord {
    if (!isValidTimeOfDay(input.timeOfDay)) {
      throw new Error(`Invalid timeOfDay: "${input.timeOfDay}" — expected 24-hour HH:MM`);
    }
    if (input.instruction.trim().length === 0) {
      throw new Error("instruction must not be empty");
    }
    if (input.instruction.length > MAX_INSTRUCTION_LENGTH) {
      throw new Error(`instruction must be at most ${MAX_INSTRUCTION_LENGTH} characters`);
    }

    const record: AutomationRuleRecord = {
      id: randomUUID(),
      timeOfDay: input.timeOfDay,
      instruction: input.instruction,
      enabled: true,
      lastTriggeredDate: null,
      createdAt: new Date().toISOString(),
    };

    this.db
      .query(
        `INSERT INTO automation_rules (id, time_of_day, instruction, enabled, last_triggered_date, created_at) VALUES (?, ?, ?, 1, NULL, ?)`
      )
      .run(record.id, record.timeOfDay, record.instruction, record.createdAt);

    return record;
  }

  list(): AutomationRuleRecord[] {
    const rows = this.db
      .query(
        `SELECT id, time_of_day as timeOfDay, instruction, enabled, last_triggered_date as lastTriggeredDate, created_at as createdAt
         FROM automation_rules ORDER BY time_of_day ASC`
      )
      .all() as Array<Omit<AutomationRuleRecord, "enabled"> & { enabled: number }>;
    return rows.map((row) => ({ ...row, enabled: row.enabled === 1 }));
  }

  private getById(id: string): AutomationRuleRecord | null {
    const row = this.db
      .query(
        `SELECT id, time_of_day as timeOfDay, instruction, enabled, last_triggered_date as lastTriggeredDate, created_at as createdAt
         FROM automation_rules WHERE id = ?`
      )
      .get(id) as (Omit<AutomationRuleRecord, "enabled"> & { enabled: number }) | null;
    return row ? { ...row, enabled: row.enabled === 1 } : null;
  }

  update(
    id: string,
    changes: { timeOfDay?: string; instruction?: string; enabled?: boolean }
  ): AutomationRuleRecord | null {
    const existing = this.getById(id);
    if (!existing) return null;

    if (changes.timeOfDay !== undefined && !isValidTimeOfDay(changes.timeOfDay)) {
      throw new Error(`Invalid timeOfDay: "${changes.timeOfDay}" — expected 24-hour HH:MM`);
    }
    if (changes.instruction !== undefined) {
      if (changes.instruction.trim().length === 0) {
        throw new Error("instruction must not be empty");
      }
      if (changes.instruction.length > MAX_INSTRUCTION_LENGTH) {
        throw new Error(`instruction must be at most ${MAX_INSTRUCTION_LENGTH} characters`);
      }
    }

    const timeOfDay = changes.timeOfDay ?? existing.timeOfDay;
    const instruction = changes.instruction ?? existing.instruction;
    const enabled = changes.enabled !== undefined ? changes.enabled : existing.enabled;

    this.db
      .query(`UPDATE automation_rules SET time_of_day = ?, instruction = ?, enabled = ? WHERE id = ?`)
      .run(timeOfDay, instruction, enabled ? 1 : 0, id);
    return { ...existing, timeOfDay, instruction, enabled };
  }

  delete(id: string): boolean {
    const result = this.db.query(`DELETE FROM automation_rules WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  /** Records that this rule actually ran today, so the scheduler doesn't fire it again until tomorrow. */
  markTriggered(id: string, dateStr: string): void {
    this.db.query(`UPDATE automation_rules SET last_triggered_date = ? WHERE id = ?`).run(dateStr, id);
  }

  close(): void {
    this.db.close();
  }
}
