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
  // PENDING -> WAITING: a task with an unresolved `dependsOnTaskId` (see
  // AgentTaskRecord.dependsOnTaskId) is gated straight into WAITING before
  // it ever reaches PLANNING — roadmap items 28/29 (Dependencies/Waiting
  // States).
  PENDING: new Set(["PLANNING", "WAITING", "CANCELLED"]),
  PLANNING: new Set(["EXECUTING", "FAILED", "CANCELLED"]),
  EXECUTING: new Set(["VERIFYING", "RETRYING", "RECOVERING", "EXECUTING", "COMPLETED", "WAITING", "FAILED", "CANCELLED"]),
  VERIFYING: new Set(["COMPLETED", "EXECUTING", "RETRYING", "RECOVERING", "WAITING", "FAILED", "CANCELLED"]),
  RETRYING: new Set(["EXECUTING", "FAILED", "CANCELLED"]),
  RECOVERING: new Set(["PLANNING", "FAILED", "CANCELLED"]),
  // WAITING -> PLANNING: once the dependency a WAITING task was gated on
  // resolves (completes), the task resumes at PLANNING exactly like a
  // brand-new PENDING task would.
  WAITING: new Set(["PLANNING", "EXECUTING", "VERIFYING", "FAILED", "CANCELLED"]),
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

/**
 * Safe, user-facing "phase" vocabulary for a structured execution timeline
 * (a UI rendering "Checking calendar… ✓ 7 events found" needs a stable
 * phase name per event, not JARVIS's more granular internal AgentTaskState).
 * Mirrored onto `agent.task.transition`'s `phase` field (see
 * src/types/events.ts) so a consumer never has to hardcode AgentTaskState's
 * exact spelling/set to render a sane timeline. RECEIVING/UNDERSTANDING
 * exist in the vocabulary for a plain chat turn (see
 * src/core/state/liveStatusFormatter.ts) but no AgentTaskState maps to
 * UNDERSTANDING — an agent task always starts already past that point.
 */
export const AGENT_TASK_PHASES = [
  "RECEIVING",
  "UNDERSTANDING",
  "PLANNING",
  "EXECUTING",
  "VERIFYING",
  "RECOVERING",
  "WAITING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;

export type AgentTaskPhase = (typeof AGENT_TASK_PHASES)[number];

/** Maps an `AgentTaskState` onto the safe `AgentTaskPhase` vocabulary above. */
export function phaseForAgentTaskState(state: AgentTaskState): AgentTaskPhase {
  switch (state) {
    case "PENDING":
      // A task that exists but hasn't started planning yet — "received but
      // not yet understood/planned", same spirit as PENDING having no
      // JarvisLiveState equivalent (see liveStateForAgentTaskState).
      return "RECEIVING";
    case "PLANNING":
      return "PLANNING";
    case "EXECUTING":
      return "EXECUTING";
    // RETRYING is still "doing the work" from a UI timeline's point of
    // view — same collapsing liveStateForAgentTaskState already does.
    case "RETRYING":
      return "EXECUTING";
    case "VERIFYING":
      return "VERIFYING";
    case "RECOVERING":
      return "RECOVERING";
    case "WAITING":
      return "WAITING";
    case "COMPLETED":
      return "COMPLETED";
    case "FAILED":
      return "FAILED";
    case "CANCELLED":
      return "CANCELLED";
  }
}
