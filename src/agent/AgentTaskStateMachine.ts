/**
 * The Autonomous Agent Core's task state machine:
 *
 *   PENDING -> PLANNING -> EXECUTING -> VERIFYING -> (COMPLETED
 *                                                     | RETRYING -> EXECUTING
 *                                                     | RECOVERING -> PLANNING
 *                                                     | WAITING
 *                                                     | FAILED
 *                                                     | CANCELLED)
 *
 * This is the single source of truth for which transitions are legal —
 * AgentTaskStore and AgentCore both go through `assertValidTransition`
 * rather than mutating state directly, so an illegal transition (e.g.
 * jumping straight from PENDING to COMPLETED, or moving anything out of a
 * terminal state) is a thrown error, not a silently-accepted bug.
 */
export const AGENT_TASK_STATES = [
  "PENDING",
  "PLANNING",
  "EXECUTING",
  "VERIFYING",
  "RETRYING",
  "RECOVERING",
  "WAITING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;

export type AgentTaskState = (typeof AGENT_TASK_STATES)[number];

/** Terminal states: once reached, a task can never transition again. */
export const AGENT_TASK_TERMINAL_STATES: ReadonlySet<AgentTaskState> = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

const TRANSITIONS: Record<AgentTaskState, ReadonlySet<AgentTaskState>> = {
  PENDING: new Set(["PLANNING", "CANCELLED"]),
  PLANNING: new Set(["EXECUTING", "FAILED", "CANCELLED"]),
  EXECUTING: new Set(["VERIFYING", "RETRYING", "RECOVERING", "EXECUTING", "COMPLETED", "WAITING", "FAILED", "CANCELLED"]),
  VERIFYING: new Set(["COMPLETED", "EXECUTING", "RETRYING", "RECOVERING", "WAITING", "FAILED", "CANCELLED"]),
  RETRYING: new Set(["EXECUTING", "FAILED", "CANCELLED"]),
  RECOVERING: new Set(["PLANNING", "FAILED", "CANCELLED"]),
  WAITING: new Set(["EXECUTING", "VERIFYING", "FAILED", "CANCELLED"]),
  COMPLETED: new Set([]),
  FAILED: new Set([]),
  CANCELLED: new Set([]),
};

export class InvalidAgentTaskTransitionError extends Error {
  constructor(
    public readonly from: AgentTaskState,
    public readonly to: AgentTaskState
  ) {
    super(`Invalid agent task transition: ${from} -> ${to}`);
    this.name = "InvalidAgentTaskTransitionError";
  }
}

export function canTransition(from: AgentTaskState, to: AgentTaskState): boolean {
  return TRANSITIONS[from].has(to);
}

/** Throws InvalidAgentTaskTransitionError if the transition isn't legal; otherwise a no-op. */
export function assertValidTransition(from: AgentTaskState, to: AgentTaskState): void {
  if (!canTransition(from, to)) {
    throw new InvalidAgentTaskTransitionError(from, to);
  }
}

export function isTerminalState(state: AgentTaskState): boolean {
  return AGENT_TASK_TERMINAL_STATES.has(state);
}
