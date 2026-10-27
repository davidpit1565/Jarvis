import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CreateGoalInput, GoalRecord, GoalStatus } from "@/types/goals";

export class GoalNotFoundError extends Error {
  constructor(id: string) {
    super(`Goal not found: ${id}`);
    this.name = "GoalNotFoundError";
  }
}

interface GoalDbRow {
  id: string;
  user_id: string;
  description: string;
  status: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

function rowToRecord(row: GoalDbRow): GoalRecord {
  return {
    id: row.id,
    userId: row.user_id,
    description: row.description,
    status: row.status as GoalStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  };
}

/**
 * Durable store for Goal identity/status, same SQLite house style as
 * ReminderStore/CommitmentStore/AgentTaskStore. A goal's *id* is the exact
 * same `goalId` string `AgentTaskStore` groups its `AgentTaskRecord`s
 * under — this store never duplicates step/progress data, it only
 * remembers what the goal actually is (the user's own words) and whether
 * it's still open, since `AgentTaskStore.goalId` is deliberately just an
 * opaque grouping key with no title of its own (see that file's doc
 * comment on `AgentTaskRecord.goalId`). Kept as a separate table/file
 * rather than added as new columns on `agent_tasks`, for the same reason
 * CommitmentStore is kept separate from ReminderStore: a Goal is a
 * distinct concept (a standing, multi-task outcome) from an individual
 * AgentTask (one step of one), and either can be backed up/reset
 * independently of the other.
 */
export class GoalStore {
  private db: Database;

  constructor(dbPath: string = ":memory:") {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    if (dbPath !== ":memory:") this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_goals_user_id ON goals(user_id)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status)`);
  }

  /**
   * Creates a goal row under a caller-supplied id. `AgentCore.startGoal`
   * generates its own `goalId` (a random UUID) when it enqueues one task
   * per decomposed step — `CREATE_GOAL` (`src/tools/agent/CreateGoalTool.ts`)
   * calls `startGoal` first, then this method with the `goalId` it
   * returned, so this store's row and `AgentTaskStore`'s grouped tasks
   * always agree on the same id without either store knowing about the
   * other's schema.
   */
  createWithId(id: string, input: CreateGoalInput): GoalRecord {
    const now = new Date().toISOString();
    const record: GoalRecord = {
      id,
      userId: input.userId,
      description: input.description,
      status: "active",
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    this.db
      .query(
        `INSERT INTO goals (id, user_id, description, status, created_at, updated_at, closed_at) VALUES (?, ?, ?, 'active', ?, ?, NULL)`
      )
      .run(record.id, record.userId, record.description, record.createdAt, record.updatedAt);
    return record;
  }

  /** Convenience for a caller that doesn't need to coordinate the id with anything else. */
  create(input: CreateGoalInput): GoalRecord {
    return this.createWithId(randomUUID(), input);
  }

  get(id: string): GoalRecord | null {
    const row = this.db.query(`SELECT * FROM goals WHERE id = ?`).get(id) as GoalDbRow | null;
    return row ? rowToRecord(row) : null;
  }

  requireOrThrow(id: string): GoalRecord {
    const goal = this.get(id);
    if (!goal) throw new GoalNotFoundError(id);
    return goal;
  }

  /** Every goal for a user, newest first, optionally filtered to one status. */
  list(userId: string, status?: GoalStatus): GoalRecord[] {
    const rows = status
      ? (this.db
          .query(`SELECT * FROM goals WHERE user_id = ? AND status = ? ORDER BY created_at DESC, rowid DESC`)
          .all(userId, status) as GoalDbRow[])
      : (this.db
          .query(`SELECT * FROM goals WHERE user_id = ? ORDER BY created_at DESC, rowid DESC`)
          .all(userId) as GoalDbRow[]);
    return rows.map(rowToRecord);
  }

  /**
   * Transitions a goal to a terminal status ("completed" or "abandoned").
   * Deliberately simple (no state-machine library of its own): a Goal
   * only ever has three states and the only illegal move is leaving a
   * terminal one, which this already prevents by matching `status =
   * 'active'` in the WHERE clause — a second call against an
   * already-closed goal is a harmless no-op (`changes === 0`), not a
   * silent double-close.
   */
  private setTerminalStatus(id: string, status: Extract<GoalStatus, "completed" | "abandoned">): GoalRecord {
    const goal = this.requireOrThrow(id);
    if (goal.status !== "active") return goal;
    const now = new Date().toISOString();
    this.db.query(`UPDATE goals SET status = ?, updated_at = ?, closed_at = ? WHERE id = ? AND status = 'active'`).run(
      status,
      now,
      now,
      id
    );
    return this.requireOrThrow(id);
  }

  complete(id: string): GoalRecord {
    return this.setTerminalStatus(id, "completed");
  }

  abandon(id: string): GoalRecord {
    return this.setTerminalStatus(id, "abandoned");
  }

  close(): void {
    this.db.close();
  }
}
