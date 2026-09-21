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

  test("charges cache-creation tokens at a 1.25x premium and cache-read tokens at a 0.1x discount, on top of input/output", () => {
    const withoutCache = estimateCostUsd("anthropic", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
    const withCacheWrite = estimateCostUsd("anthropic", {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 1_000_000,
      cacheReadInputTokens: 0,
    });
    const withCacheRead = estimateCostUsd("anthropic", {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 1_000_000,
    });
    // $3/M base input rate.
    expect(withoutCache).toBeCloseTo(3, 5);
    // 1.25x premium on the base input rate.
    expect(withCacheWrite).toBeCloseTo(3.75, 5);
    // 0.1x (90% off) the base input rate.
    expect(withCacheRead).toBeCloseTo(0.3, 5);
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

  test("getBreakdownByProvider sums spend/calls per provider, most-expensive-first", () => {
    tracker = new CostTracker(":memory:");
    tracker.record("anthropic", 0.5);
    tracker.record("anthropic", 0.3);
    tracker.record("groq", 0);

    const breakdown = tracker.getBreakdownByProvider();
    expect(breakdown).toHaveLength(2);
    expect(breakdown[0]).toMatchObject({ provider: "anthropic", calls: 2 });
    expect(breakdown[0]!.totalUsd).toBeCloseTo(0.8, 5);
    expect(breakdown.find((p) => p.provider === "groq")).toMatchObject({ provider: "groq", totalUsd: 0, calls: 1 });
  });

  test("getBreakdownByProvider(sinceIso) excludes calls recorded before that timestamp", () => {
    tracker = new CostTracker(":memory:");
    tracker.record("anthropic", 1, "2025-01-01T00:00:00.000Z");
    tracker.record("anthropic", 2, "2025-02-01T00:00:00.000Z");

    const breakdown = tracker.getBreakdownByProvider("2025-01-15T00:00:00.000Z");
    expect(breakdown).toHaveLength(1);
    expect(breakdown[0]!.totalUsd).toBeCloseTo(2, 5);
  });

  test("listRecent returns the most recent calls, newest first, bounded by limit", () => {
    tracker = new CostTracker(":memory:");
    tracker.record("anthropic", 1, "2025-01-01T00:00:00.000Z");
    tracker.record("anthropic", 2, "2025-01-02T00:00:00.000Z");
    tracker.record("groq", 0, "2025-01-03T00:00:00.000Z");

    const recent = tracker.listRecent(2);
    expect(recent).toHaveLength(2);
    expect(recent[0]!.provider).toBe("groq");
    expect(recent[1]!.estimatedCostUsd).toBeCloseTo(2, 5);
  });

  describe("per-run cost accumulator (Denial-of-wallet protection)", () => {
    test("getRunSpend is 0 for a run with no recorded cost", () => {
      tracker = new CostTracker(":memory:");
      expect(tracker.getRunSpend("never-touched")).toBe(0);
    });

    test("accumulates multiple recordRunCost calls for the same runId", () => {
      tracker = new CostTracker(":memory:");
      tracker.recordRunCost("run-1", 1.5);
      tracker.recordRunCost("run-1", 2.5);
      expect(tracker.getRunSpend("run-1")).toBeCloseTo(4, 5);
    });

    test("keeps separate runs' accumulators independent", () => {
      tracker = new CostTracker(":memory:");
      tracker.recordRunCost("run-a", 10);
      tracker.recordRunCost("run-b", 1);
      expect(tracker.getRunSpend("run-a")).toBeCloseTo(10, 5);
      expect(tracker.getRunSpend("run-b")).toBeCloseTo(1, 5);
    });

    test("resetRun clears a run's accumulator back to 0", () => {
      tracker = new CostTracker(":memory:");
      tracker.recordRunCost("run-1", 5);
      tracker.resetRun("run-1");
      expect(tracker.getRunSpend("run-1")).toBe(0);
    });

    test("per-run spend is independent of the persisted daily/monthly totals", () => {
      tracker = new CostTracker(":memory:");
      tracker.recordRunCost("run-1", 100);
      // recordRunCost never touches the persisted ai_costs table that
      // getTodaySpend/getMonthSpend read from.
      expect(tracker.getTodaySpend()).toBe(0);
      expect(tracker.getMonthSpend()).toBe(0);
    });
  });

  describe("getWeekSpend", () => {
    test("includes spend from the trailing 7 days and excludes anything older", () => {
      tracker = new CostTracker(":memory:");
      const now = "2025-06-15T12:00:00.000Z";
      tracker.record("anthropic", 1, "2025-06-10T00:00:00.000Z"); // 5 days ago — in window
      tracker.record("anthropic", 2, "2025-06-01T00:00:00.000Z"); // 14 days ago — out of window
      expect(tracker.getWeekSpend(now)).toBeCloseTo(1, 5);
    });
  });

  describe("unified AI Cost Ledger (batch 3)", () => {
    test("record() persists model/tokens/run/latency/toolCalls/fallback/taskType and listRecent returns them", () => {
      tracker = new CostTracker(":memory:");
      tracker.record("anthropic", 0.05, undefined, {
        model: "claude-sonnet-4-5-20250929",
        usage: { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 10, cacheReadInputTokens: 5 },
        runId: "run-xyz",
        latencyMs: 123,
        toolCallCount: 2,
        fallback: true,
        taskType: "chat",
      });

      const [record] = tracker.listRecent(1);
      expect(record).toMatchObject({
        provider: "anthropic",
        model: "claude-sonnet-4-5-20250929",
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationInputTokens: 10,
        cacheReadInputTokens: 5,
        runId: "run-xyz",
        latencyMs: 123,
        toolCallCount: 2,
        fallback: true,
        taskType: "chat",
      });
    });

    test("record() without details still works exactly as before (fields simply undefined)", () => {
      tracker = new CostTracker(":memory:");
      tracker.record("groq", 0);
      const [record] = tracker.listRecent(1);
      expect(record!.model).toBeUndefined();
      expect(record!.fallback).toBeUndefined();
      expect(record!.runId).toBeUndefined();
    });

    test("getBreakdownByModel groups by model, most-expensive-first, with an 'unknown' bucket for untagged calls", () => {
      tracker = new CostTracker(":memory:");
      tracker.record("anthropic", 0.5, undefined, { model: "claude-sonnet-4-5-20250929" });
      tracker.record("anthropic", 0.3, undefined, { model: "claude-sonnet-4-5-20250929" });
      tracker.record("groq", 0);

      const breakdown = tracker.getBreakdownByModel();
      expect(breakdown.find((m) => m.model === "claude-sonnet-4-5-20250929")).toMatchObject({ calls: 2 });
      expect(breakdown.find((m) => m.model === "unknown")).toMatchObject({ calls: 1 });
    });

    test("getBreakdownByTaskType groups by task type with an 'unknown' bucket", () => {
      tracker = new CostTracker(":memory:");
      tracker.record("anthropic", 0.1, undefined, { taskType: "chat" });
      tracker.record("anthropic", 0.2, undefined, { taskType: "agent-plan" });
      tracker.record("anthropic", 0.3);

      const breakdown = tracker.getBreakdownByTaskType();
      expect(breakdown.find((t) => t.taskType === "chat")).toMatchObject({ calls: 1 });
      expect(breakdown.find((t) => t.taskType === "agent-plan")).toMatchObject({ calls: 1 });
      expect(breakdown.find((t) => t.taskType === "unknown")).toMatchObject({ calls: 1 });
    });

    describe("getCacheStats", () => {
      test("all zeros / 0 hit rate when nothing has usage data recorded", () => {
        tracker = new CostTracker(":memory:");
        tracker.record("anthropic", 0.01); // no usage details at all
        const stats = tracker.getCacheStats();
        expect(stats.calls).toBe(0);
        expect(stats.cacheHitRate).toBe(0);
        expect(stats.estimatedSavingsUsd).toBe(0);
      });

      test("measures real hit rate and cache-read tokens across calls with usage data", () => {
        tracker = new CostTracker(":memory:");
        tracker.record("anthropic", 0.01, undefined, {
          usage: { inputTokens: 50, outputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 1000 },
        });
        tracker.record("anthropic", 0.02, undefined, {
          usage: { inputTokens: 200, outputTokens: 20, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        });

        const stats = tracker.getCacheStats();
        expect(stats.calls).toBe(2);
        expect(stats.callsWithCacheRead).toBe(1);
        expect(stats.cacheHitRate).toBeCloseTo(0.5, 5);
        expect(stats.cacheReadTokens).toBe(1000);
        // 1000 cache-read tokens @ $3/M * 0.9 discount = $0.0027
        expect(stats.estimatedSavingsUsd).toBeCloseTo(0.0027, 6);
      });
    });

    describe("getRunLedger", () => {
      test("returns undefined for a runId with no recorded calls", () => {
        tracker = new CostTracker(":memory:");
        expect(tracker.getRunLedger("never-touched")).toBeUndefined();
      });

      test("rolls up every dimension across a run's calls, including a fallback call", () => {
        tracker = new CostTracker(":memory:");
        tracker.record("groq", 0, "2025-01-01T00:00:00.000Z", {
          model: "llama-3.3-70b-versatile",
          usage: { inputTokens: 100, outputTokens: 20, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
          runId: "run-1",
          latencyMs: 50,
          toolCallCount: 1,
          taskType: "chat",
        });
        tracker.record("anthropic", 0.05, "2025-01-01T00:00:05.000Z", {
          model: "claude-sonnet-4-5-20250929",
          usage: { inputTokens: 200, outputTokens: 40, cacheCreationInputTokens: 0, cacheReadInputTokens: 30 },
          runId: "run-1",
          latencyMs: 400,
          toolCallCount: 0,
          fallback: true,
          taskType: "chat",
        });

        const ledger = tracker.getRunLedger("run-1");
        expect(ledger).toBeDefined();
        expect(ledger!.providers.sort()).toEqual(["anthropic", "groq"]);
        expect(ledger!.models).toContain("claude-sonnet-4-5-20250929");
        expect(ledger!.calls).toBe(2);
        expect(ledger!.inputTokens).toBe(300);
        expect(ledger!.outputTokens).toBe(60);
        expect(ledger!.cacheReadTokens).toBe(30);
        expect(ledger!.toolCalls).toBe(1);
        expect(ledger!.fallbackCount).toBe(1);
        expect(ledger!.totalLatencyMs).toBe(450);
        expect(ledger!.estimatedCostUsd).toBeCloseTo(0.05, 5);
        expect(ledger!.actualCostUsd).toBeUndefined();
        expect(ledger!.firstCallAt).toBe("2025-01-01T00:00:00.000Z");
        expect(ledger!.lastCallAt).toBe("2025-01-01T00:00:05.000Z");
      });
    });

    test("an existing database created before the ledger columns existed is migrated in place", () => {
      const path = `/tmp/jarvis-cost-tracker-migration-test-${Date.now()}.sqlite`;
      const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
      const legacyDb = new Database(path);
      legacyDb.run(`
        CREATE TABLE IF NOT EXISTS ai_costs (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          estimated_cost_usd REAL NOT NULL,
          timestamp TEXT NOT NULL
        )
      `);
      legacyDb.query(`INSERT INTO ai_costs (id, provider, estimated_cost_usd, timestamp) VALUES (?, ?, ?, ?)`).run(
        "legacy-1",
        "anthropic",
        0.1,
        "2025-01-01T00:00:00.000Z"
      );
      legacyDb.close();

      const migrated = new CostTracker(path);
      // The pre-existing row survives, with the new ledger columns simply undefined.
      const recent = migrated.listRecent(1);
      expect(recent[0]).toMatchObject({ id: "legacy-1", provider: "anthropic" });
      expect(recent[0]!.model).toBeUndefined();
      // And new-style calls with full details can be recorded right after.
      migrated.record("anthropic", 0.02, undefined, { model: "claude-sonnet-4-5-20250929" });
      expect(migrated.getBreakdownByModel().find((m) => m.model === "claude-sonnet-4-5-20250929")).toBeDefined();
      migrated.close();
    });
  });
});
