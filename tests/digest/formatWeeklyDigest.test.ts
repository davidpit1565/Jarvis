import { describe, test, expect } from "bun:test";
import { formatWeeklyDigest } from "@/digest/formatWeeklyDigest";
import type { ToolAuditSummary } from "@/audit/ToolAuditLog";
import type { TokenUsageTotals } from "@/audit/TokenUsageStore";

const toolUsage: ToolAuditSummary = {
  totalCalls: 42,
  errorCount: 2,
  errorRate: 2 / 42,
  mostUsedTool: "save_memory",
  toolCounts: [{ toolName: "save_memory", count: 10 }],
};

const tokenUsage: TokenUsageTotals = {
  inputTokens: 1000,
  outputTokens: 500,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  calls: 20,
};

describe("formatWeeklyDigest", () => {
  test("includes tool call counts, most-used tool, and token/API call counts", () => {
    const message = formatWeeklyDigest(toolUsage, tokenUsage, 1.23);

    expect(message).toContain("42");
    expect(message).toContain("2 failed");
    expect(message).toContain("save_memory");
    expect(message).toContain("1000/500");
    expect(message).toContain("20");
    expect(message).toContain("$1.23");
  });

  test("omits the cost line when cost is unavailable", () => {
    const message = formatWeeklyDigest(toolUsage, tokenUsage, undefined);
    expect(message).not.toContain("Estimated cost");
  });

  test("omits the most-used-tool line when there is none", () => {
    const message = formatWeeklyDigest({ ...toolUsage, mostUsedTool: null }, tokenUsage, undefined);
    expect(message).not.toContain("Most-used tool");
  });
});
