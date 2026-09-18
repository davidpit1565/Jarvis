import type { TokenUsageTotals } from "@/audit/TokenUsageStore";

/**
 * List prices in USD per million tokens, as published by Anthropic. Only
 * models this project actually knows the confirmed pricing for are listed
 * — for anything else, cost is reported as unavailable rather than
 * guessed, since a wrong cost estimate is worse than none for something
 * the user explicitly cares about watching. Cache write/read rates follow
 * Anthropic's standard prompt-caching multipliers (1.25x and 0.1x the
 * base input price).
 *
 * These are list prices only: they don't reflect volume discounts,
 * enterprise agreements, or price changes Anthropic may make later — treat
 * this as a rough estimate, not an invoice.
 */
const PRICING_PER_MILLION_TOKENS_USD: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-5": { input: 3, output: 15 },
};

function findPricing(model: string): { input: number; output: number } | undefined {
  const match = Object.keys(PRICING_PER_MILLION_TOKENS_USD).find((prefix) => model.startsWith(prefix));
  return match ? PRICING_PER_MILLION_TOKENS_USD[match] : undefined;
}

/** Returns an approximate USD cost for the given usage totals, or undefined if this model's pricing isn't known. */
export function estimateCostUsd(totals: TokenUsageTotals, model: string): number | undefined {
  const pricing = findPricing(model);
  if (!pricing) return undefined;

  const cacheWriteRate = pricing.input * 1.25;
  const cacheReadRate = pricing.input * 0.1;

  const cost =
    (totals.inputTokens * pricing.input +
      totals.outputTokens * pricing.output +
      totals.cacheCreationInputTokens * cacheWriteRate +
      totals.cacheReadInputTokens * cacheReadRate) /
    1_000_000;

  return Math.round(cost * 10_000) / 10_000; // 4 decimal places — cents matter at this scale
}
