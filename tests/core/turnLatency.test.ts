import { describe, it, expect } from "bun:test";
import { computeTurnLatencies } from "@/core/state/turnLatency";
import type { LiveStateTransitionEntry } from "@/audit/ToolAuditLog";

/** Builds a row the same shape `ToolAuditLog.listRecentTransitions` returns. */
function row(
  id: number,
  from: string,
  to: string,
  timestamp: string,
  reason: string | null = null
): LiveStateTransitionEntry {
  return {
    id,
    sessionId: "s1",
    userId: "u1",
    fromState: from,
    toState: to,
    reason,
    language: "en",
    timestamp,
  };
}

describe("computeTurnLatencies", () => {
  it("computes time-to-first-progress/response/total for a normal tool-using turn", () => {
    // Chronological: IDLE->THINKING (t=0), THINKING->EXECUTING (t=100),
    // EXECUTING->THINKING (t=250), THINKING->SPEAKING (t=300), SPEAKING->IDLE (t=350).
    // listRecentTransitions returns most-recent-first, so pass them reversed (highest id first).
    const oldestFirst = [
      row(1, "IDLE", "THINKING", "2026-01-01T00:00:00.000Z"),
      row(2, "THINKING", "EXECUTING", "2026-01-01T00:00:00.100Z"),
      row(3, "EXECUTING", "THINKING", "2026-01-01T00:00:00.250Z"),
      row(4, "THINKING", "SPEAKING", "2026-01-01T00:00:00.300Z"),
      row(5, "SPEAKING", "IDLE", "2026-01-01T00:00:00.350Z"),
    ];
    const mostRecentFirst = [...oldestFirst].reverse();

    const turns = computeTurnLatencies(mostRecentFirst);
    expect(turns).toHaveLength(1);
    const turn = turns[0]!;
    expect(turn.timeToFirstProgressMs).toBe(100);
    expect(turn.timeToFirstResponseMs).toBe(300);
    expect(turn.totalExecutionMs).toBe(350);
    expect(turn.endedVia).toBe("normal");
  });

  it("leaves timeToFirstProgressMs undefined for a plain reply with no tool call", () => {
    const mostRecentFirst = [
      row(3, "SPEAKING", "IDLE", "2026-01-01T00:00:00.080Z"),
      row(2, "THINKING", "SPEAKING", "2026-01-01T00:00:00.050Z"),
      row(1, "IDLE", "THINKING", "2026-01-01T00:00:00.000Z"),
    ];
    const turns = computeTurnLatencies(mostRecentFirst);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.timeToFirstProgressMs).toBeUndefined();
    expect(turns[0]!.timeToFirstResponseMs).toBe(50);
    expect(turns[0]!.totalExecutionMs).toBe(80);
  });

  it("marks a turn that ended via ERROR as endedVia: 'error' with no timeToFirstResponseMs", () => {
    const mostRecentFirst = [
      row(3, "ERROR", "IDLE", "2026-01-01T00:00:00.200Z", "recovered after error"),
      row(2, "THINKING", "ERROR", "2026-01-01T00:00:00.150Z", "boom"),
      row(1, "IDLE", "THINKING", "2026-01-01T00:00:00.000Z"),
    ];
    const turns = computeTurnLatencies(mostRecentFirst);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.endedVia).toBe("error");
    expect(turns[0]!.timeToFirstResponseMs).toBeUndefined();
    expect(turns[0]!.totalExecutionMs).toBe(200);
  });

  it("marks a turn that ended via STOPPED as endedVia: 'stopped'", () => {
    const mostRecentFirst = [
      row(3, "STOPPED", "IDLE", "2026-01-01T00:00:00.120Z"),
      row(2, "THINKING", "STOPPED", "2026-01-01T00:00:00.100Z", "user requested stop"),
      row(1, "IDLE", "THINKING", "2026-01-01T00:00:00.000Z"),
    ];
    const turns = computeTurnLatencies(mostRecentFirst);
    expect(turns[0]!.endedVia).toBe("stopped");
  });

  it("returns multiple turns, most recent first, matching input ordering", () => {
    const mostRecentFirst = [
      // Turn 2 (more recent)
      row(4, "SPEAKING", "IDLE", "2026-01-01T00:01:00.100Z"),
      row(3, "THINKING", "SPEAKING", "2026-01-01T00:01:00.050Z"),
      row(2, "IDLE", "THINKING", "2026-01-01T00:01:00.000Z"),
      // Turn 1 (older)
      row(6, "SPEAKING", "IDLE", "2026-01-01T00:00:00.100Z"),
      row(5, "THINKING", "SPEAKING", "2026-01-01T00:00:00.050Z"),
      row(1, "IDLE", "THINKING", "2026-01-01T00:00:00.000Z"),
    ];
    const turns = computeTurnLatencies(mostRecentFirst);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.turnStartAt).toBe("2026-01-01T00:01:00.000Z");
    expect(turns[1]!.turnStartAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("drops a turn that never reached its own IDLE end (bounded/partial window)", () => {
    const mostRecentFirst = [
      row(2, "THINKING", "EXECUTING", "2026-01-01T00:00:00.100Z"),
      row(1, "IDLE", "THINKING", "2026-01-01T00:00:00.000Z"),
    ];
    const turns = computeTurnLatencies(mostRecentFirst);
    expect(turns).toHaveLength(0);
  });

  it("returns an empty array for no transitions", () => {
    expect(computeTurnLatencies([])).toEqual([]);
  });
});
