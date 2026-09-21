import type { CommitmentRecord } from "@/types/commitments";

/**
 * Pure matching logic for the follow-up engine's scheduled check, kept
 * separate from the setInterval/store-mutation code so it's unit-testable
 * without timers — same pattern as getDueAutomationRules/getDueWakeUpCalls.
 * An open commitment is "stale" once it's been open at least `thresholdMs`
 * (default: configurable via JARVIS_STALE_COMMITMENT_DAYS, typically 3
 * days). `excludeIds` closes the same in-flight gap those other due-checks
 * close: a commitment whose markStale() is still being processed when the
 * next tick fires shouldn't be picked up a second time.
 */
export function getStaleCommitments(
  commitments: CommitmentRecord[],
  thresholdMs: number,
  nowIso: string,
  excludeIds: ReadonlySet<string> = new Set()
): CommitmentRecord[] {
  const nowMs = Date.parse(nowIso);
  return commitments.filter(
    (c) => c.status === "open" && nowMs - Date.parse(c.createdAt) >= thresholdMs && !excludeIds.has(c.id)
  );
}
