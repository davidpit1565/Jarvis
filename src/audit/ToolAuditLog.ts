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
