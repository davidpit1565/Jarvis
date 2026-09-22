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
  /**
   * The specific `ToolCallRequest.id` this row is for, when known —
   * Observability (Phase 43): lets a support/debugging view correlate
   * "this exact tool call" back to the `tool.requested`/`tool.executed`
   * events and (via `runId`) to the AI turn that triggered it. `null` for
   * rows written before this column existed.
   */
  toolCallId: string | null;
  /**
   * The turn/run this tool call happened within — the same `runId`
   * `Orchestrator.handleUserMessage` generates per chat turn and
   * `AgentCore` uses its `taskId` for, and the same id `CostTracker`'s
   * ledger (`getRunLedger`) already correlates AI calls by. `null` when no
   * run scope was available (e.g. a tool executed outside any tracked
   * turn/task) or for rows written before this column existed.
   */
  runId: string | null;
}

const MAX_ROWS = 5000;

/**
 * One persisted `jarvis.liveState.changed` transition (see
 * src/core/state/JarvisLiveState.ts) — "what was JARVIS doing at time T"
 * for a given live session, distinct from `AgentAuditEntry` (which is
 * scoped to one AgentCore taskId, not a live-chat session). `sessionId` is
 * the same opaque key `JarvisLiveStateTracker` uses (`${channel}:${userId}`
 * by convention).
 */
export interface LiveStateTransitionEntry {
  id: number;
  sessionId: string;
  userId: string;
  fromState: string;
  toState: string;
  reason: string | null;
  language: string | null;
  timestamp: string;
}

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

    // A third table in this same store — JARVIS's user-facing live-state
    // history (roadmap item: "what did JARVIS do 5 minutes ago", distinct
    // from `agent_audit_log`'s per-taskId scope, since a plain chat turn
    // with no AgentCore task at all still moves through LISTENING/
    // THINKING/EXECUTING/etc). Reuses this store rather than standing up a
    // second parallel audit system.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS live_state_transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        from_state TEXT NOT NULL,
        to_state TEXT NOT NULL,
        reason TEXT,
        language TEXT,
        timestamp TEXT NOT NULL
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_live_state_transitions_session_id ON live_state_transitions(session_id)`);

    // Observability (Phase 43): correlate a tool-audit row back to the
    // specific ToolCallRequest and the AI turn/task run it happened
    // within, so a support/debugging view can answer "which tool calls
    // belong to this AI call" — previously these lived in two
    // disconnected systems (CostTracker's ledger knew a call's `runId`;
    // ToolAuditLog didn't know either id at all). Additive, same
    // best-effort "ignore if already there" migration pattern as
    // MemoryStore uses for its own columns.
    for (const ddl of [
      `ALTER TABLE tool_audit_log ADD COLUMN tool_call_id TEXT`,
      `ALTER TABLE tool_audit_log ADD COLUMN run_id TEXT`,
    ]) {
      try {
        this.db.run(ddl);
      } catch {
        // already exists
      }
    }
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_tool_audit_log_run_id ON tool_audit_log(run_id)`);
  }

  /** Persists one `jarvis.liveState.changed` event — see `LiveStateTransitionEntry`. */
  recordLiveStateTransition(entry: {
    sessionId: string;
    userId: string;
    from: string;
    to: string;
    reason?: string;
    language?: string;
    timestamp?: number;
  }): void {
    const isoTimestamp = new Date(entry.timestamp ?? Date.now()).toISOString();
    this.db
      .query(
        `INSERT INTO live_state_transitions (session_id, user_id, from_state, to_state, reason, language, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(entry.sessionId, entry.userId, entry.from, entry.to, entry.reason ?? null, entry.language ?? null, isoTimestamp);

    this.db.run(
      `DELETE FROM live_state_transitions WHERE id NOT IN (SELECT id FROM live_state_transitions ORDER BY id DESC LIMIT ${MAX_ROWS})`
    );
  }

  /**
   * Bounded, most-recent-first read of one session's live-state history —
   * answers "what did JARVIS do a few minutes ago" (as opposed to
   * `JarvisLiveStateTracker.getSnapshot`, which only ever answers "what is
   * it doing right now"). Defaults to the last 20 transitions.
   */
  listRecentTransitions(sessionId: string, limit: number = 20): LiveStateTransitionEntry[] {
    return this.db
      .query(
        `SELECT id, session_id as sessionId, user_id as userId, from_state as fromState, to_state as toState, reason, language, timestamp
         FROM live_state_transitions WHERE session_id = ? ORDER BY id DESC LIMIT ?`
      )
      .all(sessionId, limit) as LiveStateTransitionEntry[];
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

  record(
    toolName: string,
    userId: string,
    input: Record<string, unknown>,
    result: ToolResult,
    correlation: { toolCallId?: string; runId?: string } = {}
  ): void {
    this.db
      .query(
        `INSERT INTO tool_audit_log (tool_name, user_id, input, success, error, timestamp, tool_call_id, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        toolName,
        userId,
        JSON.stringify(input),
        result.success ? 1 : 0,
        result.error ?? null,
        new Date().toISOString(),
        correlation.toolCallId ?? null,
        correlation.runId ?? null
      );

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
            `SELECT id, tool_name as toolName, user_id as userId, input, success, error, timestamp, tool_call_id as toolCallId, run_id as runId FROM tool_audit_log WHERE tool_name = ? ORDER BY id DESC LIMIT ?`
          )
          .all(options.toolName, limit) as Array<Omit<ToolAuditEntry, "success"> & { success: number }>)
      : (this.db
          .query(
            `SELECT id, tool_name as toolName, user_id as userId, input, success, error, timestamp, tool_call_id as toolCallId, run_id as runId FROM tool_audit_log ORDER BY id DESC LIMIT ?`
          )
          .all(limit) as Array<Omit<ToolAuditEntry, "success"> & { success: number }>);

    return rows.map((row) => ({ ...row, success: row.success === 1 }));
  }

  /**
   * Every tool-audit row recorded within one AI run/turn (the same `runId`
   * CostTracker's ledger correlates AI calls by), oldest first — the
   * concrete "which tool calls belong to this AI call" query Observability
   * (Phase 43) asks for. Empty for a `runId` that was never recorded (e.g.
   * predates this column, or the tool call ran outside any tracked run).
   */
  listByRunId(runId: string): ToolAuditEntry[] {
    const rows = this.db
      .query(
        `SELECT id, tool_name as toolName, user_id as userId, input, success, error, timestamp, tool_call_id as toolCallId, run_id as runId FROM tool_audit_log WHERE run_id = ? ORDER BY id ASC`
      )
      .all(runId) as Array<Omit<ToolAuditEntry, "success"> & { success: number }>;
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
