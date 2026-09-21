import type { ToolResult } from "@/types/tools";

/**
 * Derives a short, safe, human-readable summary of a tool's result for a
 * live execution timeline (e.g. "Checking calendar… ✓ 7 events found") —
 * item 1 of the JARVIS Master Autonomous AI Upgrade's structured event
 * model. Deliberately conservative: the only summary this ever produces is
 * a real count taken directly from an actual array in `result.data`.
 * Nothing here ever estimates, rounds, or fabricates a number — a tool
 * result with no natural safe summary (a non-array payload, an object with
 * no obvious "count", a failure) returns `undefined`, and callers must
 * omit the field entirely rather than inventing something to show.
 */
export function summarizeToolResult(result: ToolResult): string | undefined {
  if (!result.success) return undefined;

  const data = result.data;
  if (Array.isArray(data)) {
    return `${data.length} result${data.length === 1 ? "" : "s"}`;
  }

  return undefined;
}
