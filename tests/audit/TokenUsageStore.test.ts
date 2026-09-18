import { describe, test, expect } from "bun:test";
import { TokenUsageStore } from "@/audit/TokenUsageStore";

describe("TokenUsageStore", () => {
  test("totals are zero with no recorded calls", () => {
    const store = new TokenUsageStore(":memory:");
    expect(store.totals()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      calls: 0,
    });
    store.close();
  });

  test("sums usage across multiple recorded calls", () => {
    const store = new TokenUsageStore(":memory:");
    store.record({ inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 });
    store.record({ inputTokens: 200, outputTokens: 80, cacheCreationInputTokens: 500, cacheReadInputTokens: 1000 });

    expect(store.totals()).toEqual({
      inputTokens: 300,
      outputTokens: 130,
      cacheCreationInputTokens: 500,
      cacheReadInputTokens: 1000,
      calls: 2,
    });
    store.close();
  });

  test("survives across instances backed by the same SQLite file", () => {
    const dbPath = `/tmp/jarvis-token-usage-test-${crypto.randomUUID()}.sqlite`;

    const first = new TokenUsageStore(dbPath);
    first.record({ inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 });
    first.close();

    const second = new TokenUsageStore(dbPath);
    expect(second.totals().calls).toBe(1);
    expect(second.totals().inputTokens).toBe(10);
    second.close();
  });
});
