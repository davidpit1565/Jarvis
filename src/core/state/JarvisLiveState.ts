import type { EventBus } from "@/core/events/EventBus";

/**
 * JARVIS's user-facing "what am I doing right now" state machine —
 * roadmap items 92-97/101-103 and the backend half of item 36. Distinct
 * from `AgentTaskStateMachine` (src/agent/AgentTaskStateMachine.ts), which
 * governs one Autonomous Agent Core task's internal Plan/Execute/Verify
 * lifecycle: this one is the *live, per-conversation* state a frontend
 * would render (a hologram ring color, a "thinking..." caption, a mic
 * icon) and it exists independently of whether an agent task is even
 * running — a plain chat turn walks through it too.
 *
 * Deliberately NOT a global singleton: `JarvisLiveStateTracker` keys every
 * snapshot by an opaque `sessionId` the caller chooses, so the terminal
 * loop, the hologram web chat, a Telegram chat, and a phone call can each
 * be "thinking" at the same time without clobbering each other's state.
 * Callers should compose `sessionId` as `${channel}:${userId}` (or similar)
 * so the same user talking on two channels at once still gets two
 * independent live states.
 */
export const LIVE_STATES = [
  "IDLE",
  "LISTENING",
  "THINKING",
  "PLANNING",
  "EXECUTING",
  "VERIFYING",
  "WAITING",
  "SPEAKING",
  "ERROR",
  "STOPPED",
] as const;

export type LiveState = (typeof LIVE_STATES)[number];

/** Supported spoken/written reply languages, surfaced as part of the live-state payload — see item 101. */
export type LiveLanguage = "en" | "he";

export interface LiveStateSnapshot {
  sessionId: string;
  userId: string;
  state: LiveState;
  /** The language the current/most recent turn is replying in, when known. Unset until first observed. */
  language?: LiveLanguage;
  /** True once `requestStop` has been called for this session and not yet cleared by a fresh transition out of STOPPED. */
  stopRequested: boolean;
  updatedAt: number;
}

export interface LiveStateTransitionOptions {
  /** Short human-readable reason, mirrored into the emitted event and useful for logs/debugging — same spirit as AgentCore's transition reasons. */
  reason?: string;
  /** Updates the session's known reply language at the same time as the state transition, if provided. */
  language?: LiveLanguage;
}

/**
 * Legal transitions. Shape:
 *
 *   IDLE -> LISTENING | THINKING | PLANNING | STOPPED
 *   LISTENING -> THINKING | IDLE | ERROR | STOPPED
 *   THINKING -> PLANNING | EXECUTING | WAITING | SPEAKING | IDLE | ERROR | STOPPED
 *   PLANNING -> EXECUTING | IDLE | ERROR | STOPPED
 *   EXECUTING -> EXECUTING | THINKING | VERIFYING | PLANNING | WAITING | SPEAKING | IDLE | ERROR | STOPPED
 *   VERIFYING -> EXECUTING | PLANNING | WAITING | SPEAKING | IDLE | ERROR | STOPPED
 *   WAITING -> LISTENING | THINKING | EXECUTING | VERIFYING | IDLE | ERROR | STOPPED
 *   SPEAKING -> IDLE | ERROR | STOPPED
 *   ERROR -> IDLE
 *   STOPPED -> IDLE
 *
 * ERROR and STOPPED are reachable from every non-terminal-ish active state
 * (an uncaught error or a user-initiated interrupt can happen at any
 * point), and both only ever lead back to IDLE — the live state always
 * settles back to "doing nothing" rather than getting stuck.
 */
const ACTIVE_STATES: readonly LiveState[] = [
  "LISTENING",
  "THINKING",
  "PLANNING",
  "EXECUTING",
  "VERIFYING",
  "WAITING",
  "SPEAKING",
];

const BASE_TRANSITIONS: Record<LiveState, ReadonlySet<LiveState>> = {
  // PLANNING is reachable directly from IDLE too: an AgentCore task can
  // kick off without a preceding LISTENING/THINKING turn (e.g. a task
  // started from a schedule, not a live user message).
  IDLE: new Set(["LISTENING", "THINKING", "PLANNING"]),
  LISTENING: new Set(["THINKING", "IDLE"]),
  THINKING: new Set(["PLANNING", "EXECUTING", "WAITING", "SPEAKING", "IDLE"]),
  PLANNING: new Set(["EXECUTING", "IDLE"]),
  // THINKING here covers the ordinary chat tool-loop going back to the
  // Brain after tool results come back, before it decides whether to run
  // another tool or produce a final reply.
  EXECUTING: new Set(["EXECUTING", "THINKING", "VERIFYING", "PLANNING", "WAITING", "SPEAKING", "IDLE"]),
  VERIFYING: new Set(["EXECUTING", "PLANNING", "WAITING", "SPEAKING", "IDLE"]),
  WAITING: new Set(["LISTENING", "THINKING", "EXECUTING", "VERIFYING", "IDLE"]),
  SPEAKING: new Set(["IDLE"]),
  ERROR: new Set(["IDLE"]),
  STOPPED: new Set(["IDLE"]),
};

// ERROR and STOPPED are always reachable from any active state, plus IDLE
// itself can be interrupted to STOPPED (e.g. "never mind" arriving before
// anything actually started). Built once at module load, same pattern as
// AgentTaskStateMachine's TRANSITIONS table.
const TRANSITIONS: Record<LiveState, ReadonlySet<LiveState>> = Object.fromEntries(
  (Object.keys(BASE_TRANSITIONS) as LiveState[]).map((state) => {
    const targets = new Set(BASE_TRANSITIONS[state]);
    if (state !== "ERROR") targets.add("ERROR");
    if (state !== "STOPPED") targets.add("STOPPED");
    return [state, targets];
  })
) as unknown as Record<LiveState, ReadonlySet<LiveState>>;

export class InvalidLiveStateTransitionError extends Error {
  constructor(
    public readonly from: LiveState,
    public readonly to: LiveState
  ) {
    super(`Invalid JARVIS live-state transition: ${from} -> ${to}`);
    this.name = "InvalidLiveStateTransitionError";
  }
}

export function canTransitionLiveState(from: LiveState, to: LiveState): boolean {
  return TRANSITIONS[from].has(to);
}

export function assertValidLiveStateTransition(from: LiveState, to: LiveState): void {
  if (!canTransitionLiveState(from, to)) {
    throw new InvalidLiveStateTransitionError(from, to);
  }
}

export function isActiveLiveState(state: LiveState): boolean {
  return ACTIVE_STATES.includes(state);
}

/**
 * Per-session tracker: holds the current `LiveStateSnapshot` for every
 * session it has seen (an unknown session implicitly starts at IDLE) and
 * broadcasts every real transition over the EventBus as
 * `jarvis.liveState.changed`, additive to `JarvisEventMap`
 * (see src/types/events.ts). Broadcasting this further out to WebSocket
 * observer clients is a deliberate follow-up, not done here — see the
 * class doc comment on `JarvisWebSocketServer` for why.
 */
export class JarvisLiveStateTracker {
  private readonly sessions = new Map<string, LiveStateSnapshot>();

  constructor(private readonly eventBus?: EventBus) {}

  /** Current state for a session, defaulting to IDLE for a session never seen before (no snapshot is created by a plain read). */
  getState(sessionId: string): LiveState {
    return this.sessions.get(sessionId)?.state ?? "IDLE";
  }

  /** Full current snapshot, or a synthesized IDLE one (not stored) for a session never seen before. */
  getSnapshot(sessionId: string, userId: string = sessionId): LiveStateSnapshot {
    return (
      this.sessions.get(sessionId) ?? {
        sessionId,
        userId,
        state: "IDLE",
        stopRequested: false,
        updatedAt: Date.now(),
      }
    );
  }

  /** Every session this tracker currently holds a non-default snapshot for — mainly useful for tests/diagnostics. */
  listSessions(): LiveStateSnapshot[] {
    return [...this.sessions.values()];
  }

  /**
   * Applies a transition for `sessionId` (implicitly starting from IDLE if
   * this is the first transition ever seen for it) and emits
   * `jarvis.liveState.changed`. Throws `InvalidLiveStateTransitionError` for
   * an illegal transition — mirrors `AgentTaskStateMachine.assertValidTransition`'s
   * "illegal transition is a thrown bug, not a silent no-op" stance.
   * A same-state "transition" (e.g. EXECUTING -> EXECUTING for a second
   * tool call in the same turn) is always legal and still re-emits the
   * event, since callers/UIs may care about the refresh (e.g. a fresh
   * `reason` or `language`).
   */
  transition(sessionId: string, userId: string, to: LiveState, options: LiveStateTransitionOptions = {}): LiveStateSnapshot {
    const current = this.getSnapshot(sessionId, userId);
    const from = current.state;

    if (from !== to) {
      assertValidLiveStateTransition(from, to);
    }

    const next: LiveStateSnapshot = {
      sessionId,
      userId,
      state: to,
      language: options.language ?? current.language,
      // Leaving STOPPED clears the flag; anything else preserves it as-is
      // (transitioning INTO STOPPED sets it via requestStop, not here,
      // since a plain transition() call is never how a stop is requested).
      stopRequested: to === "IDLE" ? false : current.stopRequested,
      updatedAt: Date.now(),
    };
    this.sessions.set(sessionId, next);

    this.eventBus?.emit("jarvis.liveState.changed", {
      sessionId,
      userId,
      from,
      to,
      reason: options.reason,
      language: next.language,
      timestamp: next.updatedAt,
    });

    return next;
  }

  /** Updates only the known reply language for a session, without changing its state. Still emits `jarvis.liveState.changed` (from === to) so a UI already rendering the state can pick up the language change. */
  setLanguage(sessionId: string, userId: string, language: LiveLanguage): LiveStateSnapshot {
    const current = this.getSnapshot(sessionId, userId);
    return this.transition(sessionId, userId, current.state, { language, reason: "language detected" });
  }

  /**
   * Response Interrupt (roadmap item 103) for a live session. Cooperative,
   * not preemptive: it transitions the session straight to STOPPED (legal
   * from every active state) and sets `stopRequested`, which callers
   * (Orchestrator's tool-call loop, AgentCore via its own `cancel(taskId)`)
   * must poll at their own safe checkpoints between awaits — see the
   * class-level doc on `Orchestrator.handleUserMessage` for exactly where.
   * A session already IDLE/ERROR has nothing to interrupt; this is a no-op
   * for those (mirrors AgentCore.cancel's "stops before the next step"
   * semantics, never a mid-flight abort of an in-flight provider call).
   */
  requestStop(sessionId: string, userId: string, reason = "user requested stop"): LiveStateSnapshot | undefined {
    const current = this.getSnapshot(sessionId, userId);
    if (!isActiveLiveState(current.state)) return undefined;
    this.transition(sessionId, userId, "STOPPED", { reason });
    // transition() above already normalizes stopRequested for a plain
    // state change; STOPPED is the one destination that must actually
    // *set* it (a caller reaching STOPPED any other way, if one ever
    // existed, wouldn't count as a stop request) — so it's set here,
    // after the transition, directly on the stored snapshot.
    const stopped: LiveStateSnapshot = { ...this.sessions.get(sessionId)!, stopRequested: true };
    this.sessions.set(sessionId, stopped);
    return stopped;
  }

  /** Whether `requestStop` was called for this session and it hasn't since transitioned back out of STOPPED to IDLE. Callers should check this at loop checkpoints and stop early when true, then call `clearStop` once they've unwound. */
  isStopRequested(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.stopRequested ?? false;
  }

  /** Resets a session back to IDLE and clears any pending stop request — the normal way a caller settles a session once a turn (or an interrupted one) is fully unwound. */
  reset(sessionId: string, userId: string = sessionId, reason = "reset"): LiveStateSnapshot {
    const current = this.getSnapshot(sessionId, userId);
    if (current.state === "IDLE" && !current.stopRequested) return current;
    return this.transition(sessionId, userId, "IDLE", { reason });
  }
}

/** Maps an `AgentTaskState` (see src/agent/AgentTaskStateMachine.ts) onto the live-state vocabulary, for AgentCore to drive `JarvisLiveStateTracker` without this module depending on `src/agent/`. `undefined` means "no live-state change for this AgentTaskState" (PENDING has no live-state equivalent — EXECUTING/callers only start driving live state once a task actually begins PLANNING). */
export function liveStateForAgentTaskState(
  agentTaskState: "PENDING" | "PLANNING" | "EXECUTING" | "VERIFYING" | "RETRYING" | "RECOVERING" | "WAITING" | "COMPLETED" | "FAILED" | "CANCELLED"
): LiveState | undefined {
  switch (agentTaskState) {
    case "PENDING":
      return undefined;
    case "PLANNING":
      return "PLANNING";
    case "EXECUTING":
      return "EXECUTING";
    case "VERIFYING":
      return "VERIFYING";
    // RETRYING is a brief sub-state of EXECUTING from the live-state's point
    // of view — still "doing the work", nothing a UI needs a distinct
    // animation for beyond what EXECUTING already shows.
    case "RETRYING":
      return "EXECUTING";
    // RECOVERING is a brief sub-state of PLANNING (producing a fresh plan
    // after a failure) from the live-state's point of view.
    case "RECOVERING":
      return "PLANNING";
    case "WAITING":
      return "WAITING";
    case "COMPLETED":
      return "SPEAKING";
    case "FAILED":
      return "ERROR";
    case "CANCELLED":
      return "STOPPED";
  }
}
