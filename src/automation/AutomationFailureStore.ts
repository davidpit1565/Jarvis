import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface AutomationFailureEntry {
  id: number;
  ruleId: string;
  instruction: string;
  error: string;
  timestamp: string;
}

// Bounded like ToolAuditLog/ActivityLog — a real record, not an
// unbounded log file in disguise. Automation failures are expected to
// be rare relative to tool calls, so a smaller cap than ToolAuditLog's
// 5000 is plenty.
const MAX_ROWS = 500;

/**
 * A durable record of every proactive automation rule execution that
 * threw — see JARVIS_ROADMAP_AUDIT.md #177/#178. Before this, a failed
 * automation rule only ever produced a `console.error` line and an
 * ActivityLog entry: both disappear (the console on redeploy, the
 * activity ring buffer once it rolls past 30 entries), so a rule that's
 * been silently failing for days had no way to notice short of asking
 * JARVIS "did rule X run?" and getting a guess. This survives both,
 * exposed read-only via `GET /automation-failures`, and is also the one
 * place a real (if minimal) error-rate metric for automations can be
 * computed from (`list().length` over a time window).
 */
export class AutomationFailureStore {
  private db: Database;

  constructor(dbPath: string = ":memory:") {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    if (dbPath !== ":memory:") this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS automation_failures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id TEXT NOT NULL,
        instruction TEXT NOT NULL,
        error TEXT NOT NULL,
        timestamp TEXT NOT NULL
      )
    `);
  }

  record(ruleId: string, instruction: string, error: string): void {
    this.db
      .query(`INSERT INTO automation_failures (rule_id, instruction, error, timestamp) VALUES (?, ?, ?, ?)`)
      .run(ruleId, instruction, error, new Date().toISOString());

    this.db.run(
      `DELETE FROM automation_failures WHERE id NOT IN (SELECT id FROM automation_failures ORDER BY id DESC LIMIT ${MAX_ROWS})`
    );
  }

  /** Most recent failures first. */
  list(limit = 50): AutomationFailureEntry[] {
    return this.db
      .query(
        `SELECT id, rule_id as ruleId, instruction, error, timestamp FROM automation_failures ORDER BY id DESC LIMIT ?`
      )
      .all(limit) as AutomationFailureEntry[];
  }

  close(): void {
    this.db.close();
  }
}
