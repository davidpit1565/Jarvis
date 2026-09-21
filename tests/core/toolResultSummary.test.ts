import { describe, test, expect } from "bun:test";
import { summarizeToolResult } from "@/core/orchestrator/toolResultSummary";

describe("summarizeToolResult", () => {
  test("summarizes a successful array result with the real length", () => {
    expect(summarizeToolResult({ success: true, data: [1, 2, 3] })).toBe("3 results");
  });

  test("uses singular phrasing for exactly one result", () => {
    expect(summarizeToolResult({ success: true, data: ["only one"] })).toBe("1 result");
  });

  test("never fabricates a count for a non-array payload", () => {
    expect(summarizeToolResult({ success: true, data: { name: "widget" } })).toBeUndefined();
    expect(summarizeToolResult({ success: true, data: "plain text" })).toBeUndefined();
    expect(summarizeToolResult({ success: true })).toBeUndefined();
  });

  test("never summarizes a failed result", () => {
    expect(summarizeToolResult({ success: false, error: "boom", data: [1, 2, 3] })).toBeUndefined();
  });
});
