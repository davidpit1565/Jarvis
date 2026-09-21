import type { Brain, BrainRequest, BrainResponse } from "@/types/brain";
import type { EventBus } from "@/core/events/EventBus";
import { AIProviderRegistry, type ProviderName } from "./AIProviderRegistry";
import { CostTracker, estimateCostUsd } from "@/core/cost/CostTracker";

/** Thrown when a paid provider would be used but a configured budget cap is already met/exceeded and no free provider is available to fall back to. */
export class BudgetExceededError extends Error {}

/**
 * Thrown when `ZERO_COST_MODE` is on and routing would otherwise have to
 * touch a paid provider — either because no free provider is configured
 * at all, or because the free provider(s) available for this request
 * already failed. This is a hard boundary: unlike `BudgetExceededError`,
 * there is no "budget" to raise, so this always means the request cannot
 * be served right now.
 */
export class ZeroCostModeError extends Error {}

/**
 * Thrown when a provider's circuit breaker is open (it failed
 * `circuitBreakerThreshold` times in a row and its cooldown hasn't
 * elapsed yet) and no usable fallback exists either — same shape as "no
 * fallback configured", just for a provider that's configured but
 * temporarily being skipped.
 */
export class CircuitOpenError extends Error {}

/** One provider's point-in-time operational status, as exposed by `AIRouter.getProviderStatus()`. */
export interface ProviderStatus {
  configured: true;
  costTier: "free" | "paid";
  /** True if this provider's circuit breaker is currently open (routing skips it until its cooldown elapses). */
  circuitOpen: boolean;
  /** Consecutive failures currently counted against this provider (reset to 0 on any success). */
  consecutiveFailures: number;
  /** Most recent call's latency in ms, or undefined if this provider has never been called. */
  latencyMs?: number;
  /** Average latency in ms over the last (up to) `PROVIDER_STATS_WINDOW` calls, or undefined if never called. */
  averageLatencyMs?: number;
  /** Fraction (0-1) of the last (up to) `PROVIDER_STATS_WINDOW` calls that succeeded, or undefined if never called. */
  successRate?: number;
  /** How many calls the rolling stats above are computed over. */
  sampleSize: number;
}

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
  /**
   * Hard zero-cost boundary: when true, AIRouter will NEVER call a paid
   * provider, under any circumstance — not as a fallback, not when the
   * free provider fails, nothing. This is stricter than and independent
   * of `maxDailyCostUsd`/`maxMonthlyCostUsd`: those bound how much a paid
   * provider may be used; this forbids using one at all. When routing
   * would otherwise have to reach for a paid provider, AIRouter throws
   * `ZeroCostModeError` instead. Defaults to false.
   */
  zeroCostMode?: boolean;
  /** Consecutive failures before a provider's circuit breaker opens. Defaults to 3. */
  circuitBreakerThreshold?: number;
  /** How long (ms) a provider's circuit stays open before a single half-open trial call is allowed through. Defaults to 60_000. */
  circuitBreakerCooldownMs?: number;
  eventBus?: EventBus;
}

/** How many recent calls' outcome/latency each provider's rolling stats are computed over. */
const PROVIDER_STATS_WINDOW = 20;
const DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 3;
const DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS = 60_000;

type CircuitState = "closed" | "open" | "half-open";

interface ProviderRuntime {
  consecutiveFailures: number;
  circuitState: CircuitState;
  /** `Date.now()` timestamp of when the circuit most recently opened. */
  circuitOpenedAt?: number;
  /** Rolling window of the last (up to) `PROVIDER_STATS_WINDOW` calls, oldest first. */
  recentCalls: Array<{ success: boolean; latencyMs: number }>;
}

function freshRuntime(): ProviderRuntime {
  return { consecutiveFailures: 0, circuitState: "closed", recentCalls: [] };
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
 * 4. Before actually calling a *paid* primary/fallback:
 *    - `zeroCostMode` (see `ZeroCostModeError`) is enforced first — it is
 *      an absolute floor, never just a budget swap. A paid candidate is
 *      always replaced with a free one if one is available and hasn't
 *      already been tried this request, or the request fails with
 *      `ZeroCostModeError` if not.
 *    - otherwise, a configured daily/monthly budget cap (via
 *      CostTracker) can force a swap to a free provider, or throw
 *      `BudgetExceededError` if none is available.
 * 5. Before actually calling *any* candidate (free or paid), its circuit
 *    breaker (see below) must be closed or half-open — an open circuit
 *    is treated exactly like the provider being unconfigured for routing
 *    purposes, and routing moves on to whatever fallback logic (4)/(6)
 *    would otherwise apply.
 * 6. If the chosen provider's call throws, AIRouter retries once against
 *    a fallback provider (`fallbackProvider` if set and configured,
 *    otherwise whichever other provider happens to be configured), and
 *    emits an "ai.providerFallback" event either way. With only one
 *    provider configured (or usable per (4)/(5)) there is no fallback,
 *    and the original/most relevant error propagates — this must never
 *    crash on a single-provider setup.
 *
 * Circuit breaker: AIRouter tracks consecutive failures per provider.
 * After `circuitBreakerThreshold` (default 3) consecutive failures, that
 * provider's circuit opens and routing skips it entirely (as if
 * unconfigured) for `circuitBreakerCooldownMs` (default 60s). After the
 * cooldown, a single "half-open" trial call is allowed through: success
 * closes the circuit again, failure re-opens it (restarting the
 * cooldown). This is provider-name-agnostic — it keys purely off which
 * `ProviderName` is being routed to, driven by call outcomes, not by any
 * assumption about which provider is "the free one".
 *
 * Latency and success-rate tracking: every call attempt (success or
 * failure) records its wall-clock latency and outcome into a small
 * in-memory rolling window per provider (last `PROVIDER_STATS_WINDOW`
 * calls). This is operational telemetry — useful for a future status
 * endpoint, not durable state — so it deliberately lives only in this
 * `AIRouter` instance's memory and resets on restart, same lifetime as
 * the process's live provider connections themselves. `getProviderStatus()`
 * exposes it.
 */
export class AIRouter implements Brain {
  private readonly freeFirst: boolean;
  private readonly circuitBreakerThreshold: number;
  private readonly circuitBreakerCooldownMs: number;
  private readonly runtime = new Map<ProviderName, ProviderRuntime>();

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
    this.circuitBreakerThreshold = options.circuitBreakerThreshold ?? DEFAULT_CIRCUIT_BREAKER_THRESHOLD;
    this.circuitBreakerCooldownMs = options.circuitBreakerCooldownMs ?? DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS;
  }

  async chat(request: BrainRequest): Promise<BrainResponse> {
    const primary = this.applyBudget(this.resolvePrimary());
    const tried = new Set<ProviderName>([primary]);

    if (this.effectiveCircuitState(primary) === "open") {
      return this.routeToFallback(
        primary,
        request,
        "circuit-open",
        tried,
        new CircuitOpenError(this.circuitOpenMessage(primary))
      );
    }

    try {
      return await this.timedCall(primary, request);
    } catch (primaryError) {
      return this.routeToFallback(primary, request, "call-failed", tried, primaryError);
    }
  }

  /**
   * Per-provider operational status, meant for a future dashboard/status
   * endpoint. Only lists providers actually registered in
   * `AIProviderRegistry` — an unconfigured provider simply doesn't
   * appear, same as everywhere else in this class.
   */
  getProviderStatus(): Record<string, ProviderStatus> {
    const status: Record<string, ProviderStatus> = {};
    for (const meta of this.registry.list()) {
      const rt = this.runtime.get(meta.name);
      const recent = rt?.recentCalls ?? [];
      const successCount = recent.filter((call) => call.success).length;

      status[meta.name] = {
        configured: true,
        costTier: meta.costTier,
        circuitOpen: this.effectiveCircuitState(meta.name) === "open",
        consecutiveFailures: rt?.consecutiveFailures ?? 0,
        latencyMs: recent.length > 0 ? recent[recent.length - 1]!.latencyMs : undefined,
        averageLatencyMs:
          recent.length > 0 ? recent.reduce((sum, call) => sum + call.latencyMs, 0) / recent.length : undefined,
        successRate: recent.length > 0 ? successCount / recent.length : undefined,
        sampleSize: recent.length,
      };
    }
    return status;
  }

  private async routeToFallback(
    primary: ProviderName,
    request: BrainRequest,
    reason: "call-failed" | "circuit-open",
    tried: Set<ProviderName>,
    errorIfUnusable: unknown
  ): Promise<BrainResponse> {
    const fallback = this.resolveFallback(primary);
    if (!fallback) throw errorIfUnusable;

    // applyBudget may itself throw (BudgetExceededError/ZeroCostModeError)
    // — that's a more specific, more useful error than errorIfUnusable
    // and is allowed to propagate as-is.
    const actualFallback = this.applyBudget(fallback, tried);
    tried.add(actualFallback);
    if (this.effectiveCircuitState(actualFallback) === "open") throw errorIfUnusable;

    this.options.eventBus?.emit("ai.providerFallback", { from: primary, to: actualFallback, reason });
    return this.timedCall(actualFallback, request);
  }

  private async timedCall(provider: ProviderName, request: BrainRequest): Promise<BrainResponse> {
    const wasHalfOpenTrial = this.effectiveCircuitState(provider) === "half-open";
    const start = performance.now();
    try {
      const response = await this.registry.get(provider)!.chat(request);
      this.recordOutcome(provider, true, performance.now() - start, wasHalfOpenTrial);
      this.recordCost(provider, response);
      return response;
    } catch (err) {
      this.recordOutcome(provider, false, performance.now() - start, wasHalfOpenTrial);
      throw err;
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
   * Enforces, in order, the hard zero-cost boundary and then the
   * soft daily/monthly budget cap against a *paid* candidate provider.
   * Free providers and providers with no cap configured pass straight
   * through either way.
   *
   * `alreadyTried` is excluded from consideration as a zero-cost-mode
   * swap target — a free provider that already failed earlier in this
   * same request is not a usable alternative, and retrying it silently
   * would contradict "never silently degrade".
   */
  private applyBudget(candidate: ProviderName, alreadyTried: ReadonlySet<ProviderName> = new Set()): ProviderName {
    const meta = this.registry.getMeta(candidate);
    if (!meta || meta.costTier !== "paid") return candidate;

    if (this.options.zeroCostMode) {
      const free = this.registry.findByCostTier("free").find((name) => !alreadyTried.has(name));
      if (free) {
        this.options.eventBus?.emit("ai.providerFallback", { from: candidate, to: free, reason: "zero-cost-mode" });
        return free;
      }

      const noneConfiguredAtAll = this.registry.findByCostTier("free").length === 0;
      throw new ZeroCostModeError(
        noneConfiguredAtAll
          ? `ZERO_COST_MODE is enabled and no free-tier provider is configured at all — refusing to call the paid "${candidate}" provider. Chat capability is unavailable until a free-tier provider (e.g. GROQ_API_KEY) is configured or ZERO_COST_MODE is disabled.`
          : `ZERO_COST_MODE is enabled and the free-tier provider(s) available for this request already failed or are unavailable — refusing to call the paid "${candidate}" provider. Chat capability is unavailable for this request.`
      );
    }

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

  private circuitOpenMessage(provider: ProviderName): string {
    const rt = this.runtime.get(provider);
    const cooldownSec = Math.round(this.circuitBreakerCooldownMs / 1000);
    return `Provider "${provider}" circuit is open after ${rt?.consecutiveFailures ?? this.circuitBreakerThreshold} consecutive failures — refusing to call it for up to ${cooldownSec}s while it cools down, and no usable fallback is available for this request.`;
  }

  /** Reads (never mutates) whether `provider`'s circuit is currently open/half-open/closed, given the current time. */
  private effectiveCircuitState(provider: ProviderName): CircuitState {
    const rt = this.runtime.get(provider);
    if (!rt || rt.circuitState !== "open") return rt?.circuitState ?? "closed";
    const elapsed = Date.now() - (rt.circuitOpenedAt ?? 0);
    return elapsed >= this.circuitBreakerCooldownMs ? "half-open" : "open";
  }

  private recordOutcome(provider: ProviderName, success: boolean, latencyMs: number, wasHalfOpenTrial: boolean): void {
    const rt = this.runtime.get(provider) ?? freshRuntime();
    this.runtime.set(provider, rt);

    rt.recentCalls.push({ success, latencyMs });
    if (rt.recentCalls.length > PROVIDER_STATS_WINDOW) rt.recentCalls.shift();

    if (success) {
      rt.consecutiveFailures = 0;
      rt.circuitState = "closed";
      rt.circuitOpenedAt = undefined;
      return;
    }

    rt.consecutiveFailures += 1;
    const shouldOpen = wasHalfOpenTrial || rt.consecutiveFailures >= this.circuitBreakerThreshold;
    if (shouldOpen) {
      rt.circuitState = "open";
      rt.circuitOpenedAt = Date.now();
    } else {
      rt.circuitState = "closed";
    }
  }
}
