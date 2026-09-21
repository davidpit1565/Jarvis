import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ToolResult } from "@/types/tools";

export interface ToolAuditSummary {
  totalCalls: number;
  errorCount: number;
  errorRate: number;
  mostUsedTool: string | null;
  toolCounts: { toolName: string; count: number }[];
}

export interface ToolAuditEntry {
  id: number;
  toolName: string;
  userId: string;
  input: string;
  success: boolean;
  error: string | null;
  timestamp: string;
}

const MAX_ROWS = 5000;

/**
 * One event in an autonomous agent task's audit trail: a state
 * transition, a step execution, a verification verdict, or a
 * retry/recovery decision. `taskId` ties every row back to a specific
 * AgentTaskRecord; `detail` is a JSON blob with whatever context that
 * event needs to be fully reconstructable later (from/to state, the
 * step id, the tool result, the classified error, the reason a retry vs.
 * a recovery cycle was chosen, etc).
 */
export interface AgentAuditEntry {
  id: number;
  taskId: string;
  userId: string;
  event: string;
  detail: string;
  timestamp: string;
}

/**
 * A durable, structured record of every tool JARVIS has ever actually run
 * — tool name, the exact input, who ran it, and whether it succeeded —
 * distinct from ActivityLog, which is a small in-memory-first ring buffer
 * of human-readable *display* strings for the dashboard. This is the
 * accountability trail: "what did JARVIS actually do and when" for a
 * SAFE_ACTION/CONFIRM/DANGEROUS tool, in a form a human could actually
 * audit later, not just skim on a live dashboard that only keeps the last
 * 30 entries.
 */
export class ToolAuditLog {
  private db: Database;

  constructor(dbPath: string = ":memory:") {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    if (dbPath !== ":memory:") this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS tool_audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool_name TEXT NOT NULL,
        user_id TEXT NOT NULL,
        input TEXT NOT NULL,
        success INTEGER NOT NULL,
        error TEXT,
        timestamp TEXT NOT NULL
      )
    `);
    // A second table in the same store/file, not a second audit system:
    // the Autonomous Agent Core's full audit trail (state transitions,
    // verification verdicts, retry/recovery decisions) alongside the
    // existing per-tool-call trail above, which agent steps also still
    // write to via `record()` exactly like any other tool call.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS agent_audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        event TEXT NOT NULL,
        detail TEXT NOT NULL,
        timestamp TEXT NOT NULL
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_agent_audit_log_task_id ON agent_audit_log(task_id)`);
  }

  /**
   * Records one agent-task audit event — a state transition, a step
   * verification verdict, or a retry/recovery decision. `detail` is
   * whatever structured context makes that event reconstructable later
   * (e.g. `{ from: "EXECUTING", to: "RETRYING", reason: "..." }`).
   */
  recordAgentEvent(taskId: string, userId: string, event: string, detail: Record<string, unknown>): void {
    this.db
      .query(`INSERT INTO agent_audit_log (task_id, user_id, event, detail, timestamp) VALUES (?, ?, ?, ?, ?)`)
      .run(taskId, userId, event, JSON.stringify(detail), new Date().toISOString());

    this.db.run(
      `DELETE FROM agent_audit_log WHERE id NOT IN (SELECT id FROM agent_audit_log ORDER BY id DESC LIMIT ${MAX_ROWS})`
    );
  }

  /** Every audit event for one agent task, oldest first (the order they actually happened in), or across all tasks with a limit if `taskId` is omitted. */
  listAgentEvents(options: { taskId?: string; limit?: number } = {}): AgentAuditEntry[] {
    const limit = options.limit ?? 200;
    const rows = options.taskId
      ? (this.db
          .query(
            `SELECT id, task_id as taskId, user_id as userId, event, detail, timestamp FROM agent_audit_log WHERE task_id = ? ORDER BY id ASC LIMIT ?`
          )
          .all(options.taskId, limit) as AgentAuditEntry[])
      : (this.db
          .query(
            `SELECT id, task_id as taskId, user_id as userId, event, detail, timestamp FROM agent_audit_log ORDER BY id DESC LIMIT ?`
          )
          .all(limit) as AgentAuditEntry[]);
    return rows;
  }

  record(toolName: string, userId: string, input: Record<string, unknown>, result: ToolResult): void {
    this.db
      .query(
        `INSERT INTO tool_audit_log (tool_name, user_id, input, success, error, timestamp) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(toolName, userId, JSON.stringify(input), result.success ? 1 : 0, result.error ?? null, new Date().toISOString());

    // Bounded like ActivityLog/ConversationHistoryStore — a durable audit
    // trail with real limits, not an unbounded log file in disguise.
    this.db.run(
      `DELETE FROM tool_audit_log WHERE id NOT IN (SELECT id FROM tool_audit_log ORDER BY id DESC LIMIT ${MAX_ROWS})`
    );
  }

  /** Most recent entries first, optionally filtered to one tool. */
  list(options: { toolName?: string; limit?: number } = {}): ToolAuditEntry[] {
    const limit = options.limit ?? 50;
    const rows = options.toolName
      ? (this.db
          .query(
            `SELECT id, tool_name as toolName, user_id as userId, input, success, error, timestamp FROM tool_audit_log WHERE tool_name = ? ORDER BY id DESC LIMIT ?`
          )
          .all(options.toolName, limit) as Array<Omit<ToolAuditEntry, "success"> & { success: number }>)
      : (this.db
          .query(
            `SELECT id, tool_name as toolName, user_id as userId, input, success, error, timestamp FROM tool_audit_log ORDER BY id DESC LIMIT ?`
          )
          .all(limit) as Array<Omit<ToolAuditEntry, "success"> & { success: number }>);

    return rows.map((row) => ({ ...row, success: row.success === 1 }));
  }

  /**
   * Aggregate stats over everything currently retained (bounded by
   * MAX_ROWS above), for a quick "how is JARVIS actually being used"
   * glance on the dashboard rather than paging through raw entries.
   */
  summary(): ToolAuditSummary {
    const totals = this.db
      .query(`SELECT COUNT(*) as totalCalls, SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as errorCount FROM tool_audit_log`)
      .get() as { totalCalls: number; errorCount: number | null };

    const toolCounts = this.db
      .query(`SELECT tool_name as toolName, COUNT(*) as count FROM tool_audit_log GROUP BY tool_name ORDER BY count DESC`)
      .all() as { toolName: string; count: number }[];

    const totalCalls = totals.totalCalls ?? 0;
    const errorCount = totals.errorCount ?? 0;

    return {
      totalCalls,
      errorCount,
      errorRate: totalCalls > 0 ? errorCount / totalCalls : 0,
      mostUsedTool: toolCounts[0]?.toolName ?? null,
      toolCounts,
    };
  }

  close(): void {
    this.db.close();
  }
}
