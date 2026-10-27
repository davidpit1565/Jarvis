/**
 * A Goal (roadmap items 26-27) is a user-stated, multi-step outcome
 * ("help me launch my project") that JARVIS tracks across separate
 * conversations without being re-explained — this is the "Goal Engine"
 * layer, built on top of the existing Autonomous Agent Core task
 * substrate (`src/agent/AgentTaskStore.ts`/`AgentTaskStateMachine.ts`).
 *
 * `GoalStore` deliberately only stores the goal's own identity/status —
 * what it is, whose it is, and whether it's still active. The actual
 * decomposition into steps, and all progress tracking, lives entirely in
 * `AgentTaskStore` (one `AgentTaskRecord` per step, all sharing this
 * goal's id as their `goalId`); see `GoalStore`'s own doc comment for why
 * this split exists instead of one combined table.
 */
export type GoalStatus = "active" | "completed" | "abandoned";

export interface GoalRecord {
  id: string;
  userId: string;
  /** The user's own statement of what they want achieved, e.g. "launch my Rudder app on the App Store". Never invented unprompted — always created from an explicit CREATE_GOAL call. */
  description: string;
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
  /** ISO timestamp the goal was marked completed or abandoned at, or null while still active. */
  closedAt: string | null;
}

export interface CreateGoalInput {
  userId: string;
  description: string;
}
