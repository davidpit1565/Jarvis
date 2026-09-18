import { describe, test, expect } from "bun:test";
import { ToolAuditLog } from "@/audit/ToolAuditLog";

describe("ToolAuditLog", () => {
  test("records a successful tool execution", () => {
    const log = new ToolAuditLog(":memory:");
    log.record("save_memory", "user-1", { key: "user.name", value: "David" }, { success: true });

    const entries = log.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.toolName).toBe("save_memory");
    expect(entries[0]?.userId).toBe("user-1");
    expect(entries[0]?.success).toBe(true);
    expect(JSON.parse(entries[0]!.input)).toEqual({ key: "user.name", value: "David" });
    log.close();
  });

  test("records a failed tool execution with its error", () => {
    const log = new ToolAuditLog(":memory:");
    log.record("delete_memory", "user-1", { key: "missing" }, { success: false, error: "No saved fact found" });

    const [entry] = log.list();
    expect(entry?.success).toBe(false);
    expect(entry?.error).toBe("No saved fact found");
    log.close();
  });

  test("list returns most recent first", () => {
    const log = new ToolAuditLog(":memory:");
    log.record("tool_a", "user-1", {}, { success: true });
    log.record("tool_b", "user-1", {}, { success: true });

    const entries = log.list();
    expect(entries.map((e) => e.toolName)).toEqual(["tool_b", "tool_a"]);
    log.close();
  });

  test("list filters by toolName", () => {
    const log = new ToolAuditLog(":memory:");
    log.record("tool_a", "user-1", {}, { success: true });
    log.record("tool_b", "user-1", {}, { success: true });
    log.record("tool_a", "user-1", {}, { success: true });

    const entries = log.list({ toolName: "tool_a" });
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.toolName === "tool_a")).toBe(true);
    log.close();
  });

  test("list respects a custom limit", () => {
    const log = new ToolAuditLog(":memory:");
    for (let i = 0; i < 5; i++) log.record("tool_a", "user-1", {}, { success: true });

    expect(log.list({ limit: 2 })).toHaveLength(2);
    log.close();
  });

  test("summary reports zeroed stats with no recorded calls", () => {
    const log = new ToolAuditLog(":memory:");
    expect(log.summary()).toEqual({
      totalCalls: 0,
      errorCount: 0,
      errorRate: 0,
      mostUsedTool: null,
      toolCounts: [],
    });
    log.close();
  });

  test("summary reports the most-used tool and error rate", () => {
    const log = new ToolAuditLog(":memory:");
    log.record("save_memory", "user-1", {}, { success: true });
    log.record("save_memory", "user-1", {}, { success: true });
    log.record("save_memory", "user-1", {}, { success: false, error: "boom" });
    log.record("create_reminder", "user-1", {}, { success: true });

    const summary = log.summary();
    expect(summary.totalCalls).toBe(4);
    expect(summary.errorCount).toBe(1);
    expect(summary.errorRate).toBe(0.25);
    expect(summary.mostUsedTool).toBe("save_memory");
    expect(summary.toolCounts).toEqual([
      { toolName: "save_memory", count: 3 },
      { toolName: "create_reminder", count: 1 },
    ]);
    log.close();
  });

  test("survives across instances backed by the same SQLite file", () => {
    const dbPath = `/tmp/jarvis-audit-test-${crypto.randomUUID()}.sqlite`;

    const first = new ToolAuditLog(dbPath);
    first.record("save_memory", "user-1", { key: "x" }, { success: true });
    first.close();

    const second = new ToolAuditLog(dbPath);
    expect(second.list()).toHaveLength(1);
    second.close();
  });
});
