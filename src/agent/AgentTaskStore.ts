import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ToolResult } from "@/types/tools";
import { assertValidTransition, type AgentTaskState, isTerminalState } from "./AgentTaskStateMachine";
import type { AgentPlanStep, AgentStepProposal, AgentTaskRecord } from "./types";

export class AgentTaskNotFoundError extends Error {
  constructor(id: string) {
    super(`Agent task not found: ${id}`);
    this.name = "AgentTaskNotFoundError";
  }
}

interface AgentTaskDbRow {
  id: string;
  user_id: string;
  goal: string;
  state: string;
  plan: string;
  current_step_index: number;
  step_retry_count: number;
  recovery_count: number;
  total_steps_executed: number;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

/**
 * Durable store for AgentTask state, same house style as ReminderStore —
 * SQLite-backed so a multi-step agent task (and exactly which step it was
 * on, how many retries/recoveries it had used, its whole plan) survives a
 * process restart instead of silently vanishing mid-run.
 */
export class AgentTaskStore {
  private db: Database;

  constructor(dbPath: string = ":memory:") {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    if (dbPath !== ":memory:") this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS agent_tasks (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        goal TEXT NOT NULL,
        state TEXT NOT NULL,
        plan TEXT NOT NULL,
        current_step_index INTEGER NOT NULL DEFAULT 0,
        step_retry_count INTEGER NOT NULL DEFAULT 0,
        recovery_count INTEGER NOT NULL DEFAULT 0,
        total_steps_executed INTEGER NOT NULL DEFAULT 0,
        failure_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_agent_tasks_user_id ON agent_tasks(user_id)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_agent_tasks_state ON agent_tasks(state)`);
  }

  create(input: { userId: string; goal: string }): AgentTaskRecord {
    const now = new Date().toISOString();
    const record: AgentTaskRecord = {
      id: randomUUID(),
      userId: input.userId,
      goal: input.goal,
      state: "PENDING",
      plan: [],
      currentStepIndex: 0,
      stepRetryCount: 0,
      recoveryCount: 0,
      totalStepsExecuted: 0,
      failureReason: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    this.insert(record);
    return record;
  }

  private insert(record: AgentTaskRecord): void {
    this.db
      .query(
        `INSERT INTO agent_tasks
          (id, user_id, goal, state, plan, current_step_index, step_retry_count, recovery_count, total_steps_executed, failure_reason, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.userId,
        record.goal,
        record.state,
        JSON.stringify(record.plan),
        record.currentStepIndex,
        record.stepRetryCount,
        record.recoveryCount,
        record.totalStepsExecuted,
        record.failureReason,
        record.createdAt,
        record.updatedAt,
        record.completedAt
      );
  }

  get(id: string): AgentTaskRecord | null {
    const row = this.db.query(`SELECT * FROM agent_tasks WHERE id = ?`).get(id) as AgentTaskDbRow | null;
    if (!row) return null;
    return this.rowToRecord(row);
  }

  private rowToRecord(row: AgentTaskDbRow): AgentTaskRecord {
    return {
      id: row.id,
      userId: row.user_id,
      goal: row.goal,
      state: row.state as AgentTaskState,
      plan: JSON.parse(row.plan) as AgentPlanStep[],
      currentStepIndex: row.current_step_index,
      stepRetryCount: row.step_retry_count,
      recoveryCount: row.recovery_count,
      totalStepsExecuted: row.total_steps_executed,
      failureReason: row.failure_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
    };
  }

  /** Most recently created first; optionally filtered to one user. */
  list(userId?: string): AgentTaskRecord[] {
    const rows = userId
      ? (this.db
          .query(`SELECT * FROM agent_tasks WHERE user_id = ? ORDER BY created_at DESC, rowid DESC`)
          .all(userId) as AgentTaskDbRow[])
      : (this.db.query(`SELECT * FROM agent_tasks ORDER BY created_at DESC, rowid DESC`).all() as AgentTaskDbRow[]);
    return rows.map((row) => this.rowToRecord(row));
  }

  /** Like `get`, but throws AgentTaskNotFoundError instead of returning null — for callers that already know the task must exist. */
  requireOrThrow(id: string): AgentTaskRecord {
    const task = this.get(id);
    if (!task) throw new AgentTaskNotFoundError(id);
    return task;
  }

  private requireTask(id: string): AgentTaskRecord {
    return this.requireOrThrow(id);
  }

  private persist(record: AgentTaskRecord): AgentTaskRecord {
    const updated: AgentTaskRecord = { ...record, updatedAt: new Date().toISOString() };
    this.db
      .query(
        `UPDATE agent_tasks SET
           state = ?, plan = ?, current_step_index = ?, step_retry_count = ?,
           recovery_count = ?, total_steps_executed = ?, failure_reason = ?,
           updated_at = ?, completed_at = ?
         WHERE id = ?`
      )
      .run(
        updated.state,
        JSON.stringify(updated.plan),
        updated.currentStepIndex,
        updated.stepRetryCount,
        updated.recoveryCount,
        updated.totalStepsExecuted,
        updated.failureReason,
        updated.updatedAt,
        updated.completedAt,
        updated.id
      );
    return updated;
  }

  /**
   * Validates the transition against the state machine before applying it
   * — an illegal transition throws instead of silently corrupting a task's
   * history. Reaching a terminal state stamps `completedAt`.
   */
  setState(id: string, to: AgentTaskState): AgentTaskRecord {
    const task = this.requireTask(id);
    assertValidTransition(task.state, to);
    return this.persist({
      ...task,
      state: to,
      completedAt: isTerminalState(to) ? new Date().toISOString() : task.completedAt,
    });
  }

  /** Installs a fresh plan (from PLANNING or a RECOVERING replan) and resets per-step counters. */
  setPlan(id: string, proposals: AgentStepProposal[]): AgentTaskRecord {
    const task = this.requireTask(id);
    const plan: AgentPlanStep[] = proposals.map((proposal) => ({
      id: randomUUID(),
      description: proposal.description,
      toolName: proposal.toolName,
      input: proposal.input,
      status: "pending",
    }));
    return this.persist({ ...task, plan, currentStepIndex: 0, stepRetryCount: 0 });
  }

  /** Records the outcome of running the current step's tool call. */
  recordStepResult(id: string, stepId: string, result: ToolResult): AgentTaskRecord {
    const task = this.requireTask(id);
    const status: AgentPlanStep["status"] = result.success ? "succeeded" : "failed";
    const plan = task.plan.map((step) => (step.id === stepId ? { ...step, status, lastResult: result } : step));
    return this.persist({ ...task, plan, totalStepsExecuted: task.totalStepsExecuted + 1 });
  }

  /** Records a verification verdict for the current step. */
  markStepVerified(id: string, stepId: string, verified: boolean, reason: string): AgentTaskRecord {
    const task = this.requireTask(id);
    const status: AgentPlanStep["status"] = verified ? "verified" : "verification_failed";
    const plan = task.plan.map((step) => (step.id === stepId ? { ...step, status, verificationReason: reason } : step));
    return this.persist({ ...task, plan });
  }

  /** Moves on to the next plan step and resets the retry counter for it. */
  advanceStep(id: string): AgentTaskRecord {
    const task = this.requireTask(id);
    return this.persist({ ...task, currentStepIndex: task.currentStepIndex + 1, stepRetryCount: 0 });
  }

  incrementStepRetry(id: string): AgentTaskRecord {
    const task = this.requireTask(id);
    return this.persist({ ...task, stepRetryCount: task.stepRetryCount + 1 });
  }

  incrementRecoveryCount(id: string): AgentTaskRecord {
    const task = this.requireTask(id);
    return this.persist({ ...task, recoveryCount: task.recoveryCount + 1 });
  }

  setFailureReason(id: string, reason: string): AgentTaskRecord {
    const task = this.requireTask(id);
    return this.persist({ ...task, failureReason: reason });
  }

  close(): void {
    this.db.close();
  }
}
