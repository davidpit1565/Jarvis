import type { LiveStateTransitionEntry } from "@/audit/ToolAuditLog";

/**
 * User-facing performance metrics for one turn (Phase 45), computed
 * entirely from `live_state_transitions` rows JARVIS was already
 * persisting (`ToolAuditLog.recordLiveStateTransition`/
 * `listRecentTransitions`) — no new tracking system, no new column,
 * nothing measured that wasn't already being measured. A turn is bounded
 * by a transition out of `IDLE` (its start) and the next transition back
 * into `IDLE` (its end) for the same session, exactly the shape
 * `Orchestrator.handleUserMessage`/`JarvisLiveStateTracker.reset` already
 * produce for every plain chat turn, Fast Path hit, and status/why-query
 * shortcut alike.
 */
export interface TurnLatency {
  /** ISO timestamp of the transition that started this turn (out of IDLE). */
  turnStartAt: string;
  /** ISO timestamp this turn settled back to IDLE (or was left via ERROR/STOPPED — see `endedVia`). */
  turnEndAt: string;
  /** How the turn ended: a normal reset back to IDLE, or via an ERROR/STOPPED transition immediately before it. */
  endedVia: "normal" | "error" | "stopped";
  /**
   * Time from turn start to the first sign of real progress beyond
   * "thinking" — the first transition into EXECUTING, VERIFYING, PLANNING
   * or WAITING. `undefined` when the turn never did any of that (e.g. a
   * plain reply with no tool call, or Fast Path's own tool-then-reply
   * shape never leaves EXECUTING out of scope — see note below).
   */
  timeToFirstProgressMs?: number;
  /**
   * Time from turn start to the first SPEAKING transition (the final
   * reply was ready to send). `undefined` when the turn never reached
   * SPEAKING (stopped or errored before producing a reply).
   */
  timeToFirstResponseMs?: number;
  /** Time from turn start to turn end — the total wall-clock time this turn actually took. */
  totalExecutionMs: number;
}

const PROGRESS_STATES = new Set(["EXECUTING", "VERIFYING", "PLANNING", "WAITING"]);

/**
 * Groups `transitions` (as `ToolAuditLog.listRecentTransitions` returns
 * them — most-recent-first, one session) into per-turn latency summaries,
 * most recent turn first. A "turn" here is any IDLE -> ... -> IDLE
 * sequence, which covers a plain chat turn, a Fast Path hit, and the
 * status-query/why-query fast paths alike (all of them still call
 * `JarvisLiveStateTracker.transition`/`reset` around whatever shortcut
 * they took). Rows that don't form a complete IDLE-bounded turn (e.g. the
 * oldest visible row cuts off mid-turn, since `listRecentTransitions` is
 * bounded) are silently dropped rather than reported as a partial/wrong
 * turn.
 */
export function computeTurnLatencies(transitions: LiveStateTransitionEntry[]): TurnLatency[] {
  // Work oldest-first internally — the input arrives most-recent-first.
  const oldestFirst = [...transitions].reverse();

  const turns: TurnLatency[] = [];
  let turnStart: LiveStateTransitionEntry | null = null;
  let firstProgressAt: string | undefined;
  let firstResponseAt: string | undefined;
  let lastBeforeIdle: LiveStateTransitionEntry | null = null;

  for (const row of oldestFirst) {
    if (row.fromState === "IDLE" && row.toState !== "IDLE") {
      // A new turn starting — if a previous one never reached its own IDLE
      // end (a gap in this bounded window), discard it rather than guess.
      turnStart = row;
      firstProgressAt = undefined;
      firstResponseAt = undefined;
      lastBeforeIdle = null;
      continue;
    }

    if (!turnStart) continue;

    if (firstProgressAt === undefined && PROGRESS_STATES.has(row.toState)) {
      firstProgressAt = row.timestamp;
    }
    if (firstResponseAt === undefined && row.toState === "SPEAKING") {
      firstResponseAt = row.timestamp;
    }

    if (row.toState === "IDLE") {
      const startMs = Date.parse(turnStart.timestamp);
      const endMs = Date.parse(row.timestamp);
      turns.push({
        turnStartAt: turnStart.timestamp,
        turnEndAt: row.timestamp,
        endedVia: lastBeforeIdle?.toState === "ERROR" ? "error" : lastBeforeIdle?.toState === "STOPPED" ? "stopped" : "normal",
        timeToFirstProgressMs: firstProgressAt ? Date.parse(firstProgressAt) - startMs : undefined,
        timeToFirstResponseMs: firstResponseAt ? Date.parse(firstResponseAt) - startMs : undefined,
        totalExecutionMs: endMs - startMs,
      });
      turnStart = null;
      firstProgressAt = undefined;
      firstResponseAt = undefined;
      lastBeforeIdle = null;
      continue;
    }

    lastBeforeIdle = row;
  }

  return turns.reverse();
}
