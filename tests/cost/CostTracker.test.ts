import { describe, test, expect, afterEach } from "bun:test";
import { CostTracker, estimateCostUsd } from "@/core/cost/CostTracker";

describe("estimateCostUsd", () => {
  test("is always exactly $0 for groq, regardless of usage", () => {
    expect(estimateCostUsd("groq")).toBe(0);
    expect(estimateCostUsd("groq", { inputTokens: 100_000, outputTokens: 50_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 })).toBe(0);
  });

  test("estimates anthropic cost from usage using the documented approximate per-token rates", () => {
    const cost = estimateCostUsd("anthropic", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
    // 1M input @ $3/M + 1M output @ $15/M
    expect(cost).toBeCloseTo(18, 5);
  });

  test("falls back to a flat approximate cost for a paid provider with no usage data", () => {
    const cost = estimateCostUsd("anthropic");
    expect(cost).toBeGreaterThan(0);
  });
});

describe("CostTracker", () => {
  let tracker: CostTracker;

  afterEach(() => {
    tracker?.close();
  });

  test("starts with zero spend", () => {
    tracker = new CostTracker(":memory:");
    expect(tracker.getTodaySpend()).toBe(0);
    expect(tracker.getMonthSpend()).toBe(0);
  });

  test("records a call and reflects it in today's and this month's spend", () => {
    tracker = new CostTracker(":memory:");
    const now = new Date().toISOString();
    tracker.record("anthropic", 0.05, now);
    tracker.record("anthropic", 0.02, now);

    expect(tracker.getTodaySpend(now)).toBeCloseTo(0.07, 5);
    expect(tracker.getMonthSpend(now)).toBeCloseTo(0.07, 5);
  });

  test("excludes spend from a different UTC day from today's total", () => {
    tracker = new CostTracker(":memory:");
    tracker.record("anthropic", 1, "2025-01-01T12:00:00.000Z");

    expect(tracker.getTodaySpend("2025-01-02T12:00:00.000Z")).toBe(0);
    // Same month, different day -> still counted in the monthly total.
    expect(tracker.getMonthSpend("2025-01-02T12:00:00.000Z")).toBe(1);
  });

  test("excludes spend from a different UTC month from the monthly total", () => {
    tracker = new CostTracker(":memory:");
    tracker.record("anthropic", 1, "2025-01-31T23:59:00.000Z");

    expect(tracker.getMonthSpend("2025-02-01T00:00:00.000Z")).toBe(0);
  });

  test("free-provider calls recorded at $0 don't inflate spend", () => {
    tracker = new CostTracker(":memory:");
    const now = new Date().toISOString();
    tracker.record("groq", 0, now);

    expect(tracker.getTodaySpend(now)).toBe(0);
  });

  test("persists across instances against the same file path", () => {
    const path = `/tmp/jarvis-cost-tracker-test-${Date.now()}.sqlite`;
    const first = new CostTracker(path);
    const now = new Date().toISOString();
    first.record("anthropic", 0.5, now);
    first.close();

    const second = new CostTracker(path);
    expect(second.getTodaySpend(now)).toBeCloseTo(0.5, 5);
    second.close();
  });
});
