import type { Brain, BrainRequest, BrainResponse } from "@/types/brain";
import type { EventBus } from "@/core/events/EventBus";
import { AIProviderRegistry, type ProviderName } from "./AIProviderRegistry";
import { CostTracker, estimateCostUsd } from "@/core/cost/CostTracker";

/** Thrown when a paid provider would be used but a configured budget cap is already met/exceeded and no free provider is available to fall back to. */
export class BudgetExceededError extends Error {}

export interface AIRouterOptions {
  /**
   * Prefer a free-tier provider when no explicit provider is pinned and
   * more than one is configured. Defaults to true.
   */
  freeFirst?: boolean;
  /**
   * The provider named by an explicit JARVIS_BRAIN_PROVIDER. When set,
   * AIRouter always uses it as the primary provider — AI_FREE_FIRST never
   * switches away from an explicit choice, only failure/budget recovery
   * can still move off it.
   */
  explicitProvider?: ProviderName;
  /** Explicit AI_FALLBACK_PROVIDER override for which provider to retry on failure/budget cap. */
  fallbackProvider?: ProviderName;
  maxDailyCostUsd?: number;
  maxMonthlyCostUsd?: number;
  eventBus?: EventBus;
}

/**
 * Wraps an `AIProviderRegistry` and implements `Brain` itself, so it's a
 * drop-in replacement anywhere a single `Brain` is passed today (see
 * src/index.ts) — Orchestrator/ConversationManager need no changes.
 *
 * Routing policy, in order:
 * 1. An explicit `explicitProvider` (JARVIS_BRAIN_PROVIDER set) is always
 *    the primary — free-first never overrides an explicit choice.
 * 2. Otherwise, if `freeFirst` and a free provider is configured, it's
 *    primary.
 * 3. Otherwise, anthropic if configured, else groq, else whatever's
 *    registered.
 * 4. Before actually calling a *paid* primary/fallback, a configured
 *    daily/monthly budget cap (via CostTracker) can force a swap to a
 *    free provider, or throw BudgetExceededError if none is available.
 * 5. If the chosen provider's call throws, AIRouter retries once against
 *    a fallback provider (`fallbackProvider` if set and configured,
 *    otherwise whichever other provider happens to be configured), and
 *    emits an "ai.providerFallback" event either way. With only one
 *    provider configured there is no fallback, and the original error
 *    propagates — this must never crash on a single-provider setup.
 */
export class AIRouter implements Brain {
  private readonly freeFirst: boolean;

  constructor(
    private readonly registry: AIProviderRegistry,
    private readonly costTracker: CostTracker,
    private readonly options: AIRouterOptions = {}
  ) {
    if (registry.listConfigured().length === 0) {
      throw new Error(
        "AIRouter: no AI provider is configured — register at least one Brain in AIProviderRegistry (ANTHROPIC_API_KEY and/or GROQ_API_KEY)."
      );
    }
    this.freeFirst = options.freeFirst ?? true;
  }

  async chat(request: BrainRequest): Promise<BrainResponse> {
    const primary = this.applyBudget(this.resolvePrimary());

    try {
      const response = await this.registry.get(primary)!.chat(request);
      this.recordCost(primary, response);
      return response;
    } catch (primaryError) {
      const fallback = this.resolveFallback(primary);
      if (!fallback) throw primaryError;

      const actualFallback = this.applyBudget(fallback);
      this.options.eventBus?.emit("ai.providerFallback", { from: primary, to: actualFallback, reason: "call-failed" });

      const response = await this.registry.get(actualFallback)!.chat(request);
      this.recordCost(actualFallback, response);
      return response;
    }
  }

  private resolvePrimary(): ProviderName {
    if (this.options.explicitProvider && this.registry.has(this.options.explicitProvider)) {
      return this.options.explicitProvider;
    }

    if (this.freeFirst) {
      const free = this.registry.findByCostTier("free")[0];
      if (free) return free;
    }

    if (this.registry.has("anthropic")) return "anthropic";
    if (this.registry.has("groq")) return "groq";
    // The constructor already guarantees at least one provider is
    // registered, so this is always defined in practice.
    return this.registry.listConfigured()[0]!;
  }

  private resolveFallback(primary: ProviderName): ProviderName | undefined {
    if (
      this.options.fallbackProvider &&
      this.options.fallbackProvider !== primary &&
      this.registry.has(this.options.fallbackProvider)
    ) {
      return this.options.fallbackProvider;
    }
    return this.registry.listConfigured().find((name) => name !== primary);
  }

  /**
   * Enforces MAX_DAILY_COST_USD/MAX_MONTHLY_COST_USD against a *paid*
   * candidate provider: swaps to a free one if the cap is already met and
   * one is available, or throws BudgetExceededError if not. Free
   * providers and providers with no cap configured pass straight
   * through.
   */
  private applyBudget(candidate: ProviderName): ProviderName {
    const meta = this.registry.getMeta(candidate);
    if (!meta || meta.costTier !== "paid") return candidate;

    const dailyExceeded =
      this.options.maxDailyCostUsd !== undefined && this.costTracker.getTodaySpend() >= this.options.maxDailyCostUsd;
    const monthlyExceeded =
      this.options.maxMonthlyCostUsd !== undefined &&
      this.costTracker.getMonthSpend() >= this.options.maxMonthlyCostUsd;

    if (!dailyExceeded && !monthlyExceeded) return candidate;

    const free = this.registry.findByCostTier("free")[0];
    if (free) {
      this.options.eventBus?.emit("ai.providerFallback", { from: candidate, to: free, reason: "budget-exceeded" });
      return free;
    }

    const period = dailyExceeded ? "daily" : "monthly";
    throw new BudgetExceededError(
      `AI ${period} budget exceeded and no free-tier provider is configured to fall back to — refusing to call the paid "${candidate}" provider.`
    );
  }

  private recordCost(provider: ProviderName, response: BrainResponse): void {
    // Failed calls aren't recorded: a call that errors (network failure,
    // 429/5xx) is the common case where no tokens were actually billed,
    // and without a response there's no usage data to estimate from
    // anyway — recording a guessed cost for it would be less honest than
    // recording nothing.
    const cost = estimateCostUsd(provider, response.usage);
    this.costTracker.record(provider, cost);
  }
}
