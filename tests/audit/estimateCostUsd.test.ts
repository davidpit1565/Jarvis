import { describe, test, expect } from "bun:test";
import { estimateCostUsd } from "@/audit/estimateCostUsd";

describe("estimateCostUsd", () => {
  test("returns undefined for an unknown model", () => {
    const cost = estimateCostUsd(
      { inputTokens: 1_000_000, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, calls: 1 },
      "some-unlisted-model"
    );
    expect(cost).toBeUndefined();
  });

  test("computes input + output cost at list price for a known model", () => {
    const cost = estimateCostUsd(
      { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, calls: 1 },
      "claude-sonnet-4-5-20250929"
    );
    // $3/M input + $15/M output
    expect(cost).toBe(18);
  });

  test("applies cache write (1.25x) and cache read (0.1x) multipliers", () => {
    const cost = estimateCostUsd(
      { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 1_000_000, cacheReadInputTokens: 1_000_000, calls: 1 },
      "claude-sonnet-4-5-20250929"
    );
    // (3 * 1.25) + (3 * 0.1) = 3.75 + 0.3
    expect(cost).toBe(4.05);
  });

  test("matches by model prefix, ignoring date suffix", () => {
    const cost = estimateCostUsd(
      { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, calls: 0 },
      "claude-sonnet-4-5-20250929"
    );
    expect(cost).toBe(0);
  });
});
