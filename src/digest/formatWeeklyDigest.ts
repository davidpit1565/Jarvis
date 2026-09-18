import type { ToolAuditSummary } from "@/audit/ToolAuditLog";
import type { TokenUsageTotals } from "@/audit/TokenUsageStore";

/**
 * Plain-text weekly usage/cost summary, meant to be pushed via
 * NOTIFY_USER-style delivery (Telegram) so "how has JARVIS been doing"
 * shows up on its own instead of only ever being answerable if you ask.
 * All-time figures (matching ToolAuditLog/TokenUsageStore, which only
 * track running totals, not weekly windows) — labeled as such so it never
 * reads as "this week's" numbers when it isn't.
 */
export function formatWeeklyDigest(
  toolUsage: ToolAuditSummary,
  tokenUsage: TokenUsageTotals,
  estimatedCostUsd: number | undefined
): string {
  const lines = ["JARVIS weekly digest (all-time totals):"];
  lines.push(`Tool calls: ${toolUsage.totalCalls} (${toolUsage.errorCount} failed)`);
  if (toolUsage.mostUsedTool) {
    lines.push(`Most-used tool: ${toolUsage.mostUsedTool}`);
  }
  lines.push(`API calls: ${tokenUsage.calls}, tokens in/out: ${tokenUsage.inputTokens}/${tokenUsage.outputTokens}`);
  if (estimatedCostUsd !== undefined) {
    lines.push(`Estimated cost so far: $${estimatedCostUsd.toFixed(2)}`);
  }
  return lines.join("\n");
}
