import type { Brain, BrainRequest, BrainResponse } from "@/types/brain";
import type { EventBus } from "@/core/events/EventBus";
import { AIProviderRegistry, type ProviderName } from "./AIProviderRegistry";
import { CostTracker, estimateCostUsd } from "@/core/cost/CostTracker";
import { modelsForProvider, type ModelCapabilities } from "./ModelCatalog";

/** Thrown when a paid provider would be used but a configured budget cap is already met/exceeded and no free provider is available to fall back to. */
export class BudgetExceededError extends Error {}

/**
 * Denial-of-wallet protection: thrown when a paid provider would be used
 * but this specific run (`request.runId` — one `handleUserMessage` turn
 * or one `AgentCore` task) has already spent at least `maxCostPerRunUsd`
 * and no free provider is available to fall back to. Distinct from
 * `BudgetExceededError`: that one bounds total spend across every run
 * (daily/monthly); this one bounds a single runaway run/task (a retry
 * loop, a plan that keeps re-calling the same expensive tool) regardless
 * of how far under the daily/monthly cap the account still is overall.
 */
export class RunBudgetExceededError extends Error {}

/**
 * Fallback Correctness: thrown when a request declares a hard capability
 * requirement (today, only "this request has an attached image") that
 * *no* configured provider's `ModelCatalog` entry supports — routing
 * refuses outright rather than silently sending the request to a
 * provider that would ignore or error on the image. See
 * `requestNeedsVision`/`providerSupportsVision` below.
 */
export class NoCapableProviderError extends Error {}

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
   * Denial-of-wallet protection: hard ceiling (USD) on estimated spend
   * within a single run (`request.runId` — one `handleUserMessage` turn
   * or one `AgentCore` task). Once a run's own accumulated spend reaches
   * this, further paid-provider calls *within that same run* fall back
   * to a free provider (or throw `RunBudgetExceededError` if none is
   * available) — independent of, and checked before, the daily/monthly
   * caps below, which only bound spend in aggregate and wouldn't catch a
   * single runaway retry/verification loop still well under the daily
   * total. A request with no `runId` set is never subject to this cap.
   * Unset means unlimited (today's behavior).
   */
  maxCostPerRunUsd?: number;
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
  /**
   * Budget-constrained degradation (JARVIS_ROADMAP_AUDIT.md batch 3): once
   * today's or this month's spend reaches this *fraction* of
   * `maxDailyCostUsd`/`maxMonthlyCostUsd` (e.g. 0.8 = 80%), a paid
   * candidate is proactively swapped for a free provider — same as
   * reaching the cap outright, just earlier — instead of only reacting
   * once the hard cap is already hit. This is a soft, graceful nudge
   * toward the free tier while budget is still technically available, not
   * a new hard boundary: unlike the hard cap, there's no
   * `BudgetExceededError` if no free provider exists to swap to — the
   * paid candidate is used as normal, exactly like today's behavior below
   * the threshold. Ignored when neither `maxDailyCostUsd` nor
   * `maxMonthlyCostUsd` is configured (there's no cap to be "close to").
   * Defaults to 0.8; set to a value >= 1 (or Infinity) to disable.
   */
  softBudgetCapRatio?: number;
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
/** Default fraction of a configured daily/monthly cap at which budget-constrained degradation starts biasing toward free providers. See `AIRouterOptions.softBudgetCapRatio`. */
const DEFAULT_SOFT_BUDGET_CAP_RATIO = 0.8;

/** Coarse, ordered ranking of `ModelCatalogEntry.capabilities.quality` — used only to pick a "stronger" model for escalation, never for routine routing. */
const QUALITY_RANK: Record<ModelCapabilities["quality"], number> = { basic: 0, good: 1, excellent: 2 };

/**
 * A request "needs vision" if any user message carries at least one
 * attached image — the same real, already-live signal `ClaudeBrain`/
 * `GroqBrain`/`OpenRouterBrain` each already read off `message.images`
 * to build their own provider-specific request bodies. This is not
 * speculative plumbing: it's the one capability JARVIS's message flow
 * genuinely already exercises (see `UserMessageImage`/`Orchestrator`'s
 * image handling).
 */
function requestNeedsVision(request: BrainRequest): boolean {
  return request.messages.some((message) => message.role === "user" && (message.images?.length ?? 0) > 0);
}

/** Whether `provider`'s catalog entry/entries claim vision support. Only one model per provider is in `MODEL_CATALOG` today, so this is exact, not a guess. */
function providerSupportsVision(provider: ProviderName): boolean {
  return modelsForProvider(provider).some((entry) => entry.capabilities.vision);
}

/** The highest `quality` rank any cataloged model for `provider` reaches, or -1 if `provider` has no catalog entry at all. */
function maxQualityForProvider(provider: ProviderName): number {
  return modelsForProvider(provider).reduce((max, entry) => Math.max(max, QUALITY_RANK[entry.capabilities.quality]), -1);
}

/**
 * "Why did you use this model?" decision metadata (JARVIS_ROADMAP_AUDIT.md
 * batch 4): a closed set of enum values naming the real `AIRouter` code
 * path that decided which provider actually served one call — never
 * free-text, and never LLM-generated. Persisted per-call via
 * `CostCallDetails.decisionReason`/`CostRecord.decisionReason` and exposed
 * through `GET /cost-analytics` (aggregate `recent` list and
 * `?runId=` ledger). The "no-story" default case (nothing special fired,
 * this was just the normal free-first/only/explicit pick) is one of
 * `"primary-free-first"`, `"primary-explicit"`, `"primary-default"` —
 * still a real, honest answer, just "no special condition applied" rather
 * than an invented reason.
 */
export type ProviderDecisionReason =
  | "primary-explicit"
  | "primary-free-first"
  | "primary-default"
  | "vision-required"
  | "zero-cost-mode"
  | "budget-exceeded"
  | "run-budget-exceeded"
  | "soft-budget-cap"
  | "circuit-open"
  | "call-failed"
  | "escalation-retry";

/** Mutable single-slot holder threaded through one call's routing decisions, so the final actual reason (which may get overridden by a later, more specific decision — e.g. "primary-free-first" overridden by "budget-exceeded" when the budget check swaps providers) can be read back by the caller. */
interface DecisionRef {
  value: ProviderDecisionReason;
}

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
    return this.chatInternal(request);
  }

  /**
   * Model Escalation: calls `chat()` normally, then — only if `isValid`
   * (a caller-supplied, deterministic check: schema validation, non-empty
   * response, tool-call parse success — never "ask another AI call to
   * judge this one") rejects the response — retries **once** against a
   * genuinely *stronger* allowed provider (by `ModelCatalog` `quality`),
   * respecting every existing boundary along the way: `zeroCostMode`
   * (never escalates to a paid provider when it's on), the daily/monthly
   * and per-run budget caps, and the circuit breaker. If no stronger
   * provider is configured, the escalation call itself fails, or budget/
   * zero-cost-mode forbids it, this simply returns the original
   * (possibly-invalid) response rather than throwing — escalation is a
   * best-effort improvement on top of a call that already succeeded, and
   * must never turn an otherwise-working turn into a hard failure.
   */
  async chatWithEscalation(request: BrainRequest, isValid: (response: BrainResponse) => boolean): Promise<BrainResponse> {
    const used: { value?: ProviderName } = {};
    const first = await this.chatInternal(request, used);
    if (isValid(first) || !used.value) return first;

    const candidate = this.resolveEscalationCandidate(used.value, request);
    if (!candidate) return first;

    let actual: ProviderName;
    try {
      actual = this.applyBudget(candidate, request, new Set([used.value]));
    } catch {
      // Escalating isn't affordable/allowed right now (budget cap,
      // ZERO_COST_MODE) — that's not a reason to fail a call that
      // already produced *a* response; return it as-is.
      return first;
    }
    if (actual === used.value || this.effectiveCircuitState(actual) === "open") return first;

    this.options.eventBus?.emit("ai.escalation", { from: used.value, to: actual, reason: "validation-failed" });
    try {
      return await this.timedCall(actual, request, true, { value: "escalation-retry" });
    } catch {
      // The stronger provider's call itself failed — fall back to the
      // original response rather than throwing, and never retry again
      // (escalation is capped at exactly one attempt).
      return first;
    }
  }

  private async chatInternal(request: BrainRequest, providerUsedOut?: { value?: ProviderName }): Promise<BrainResponse> {
    const resolved = this.resolvePrimaryWithReason(request);
    const decisionRef: DecisionRef = { value: resolved.reason };
    const primary = this.applyBudget(resolved.provider, request, undefined, decisionRef);
    const tried = new Set<ProviderName>([primary]);

    if (this.effectiveCircuitState(primary) === "open") {
      decisionRef.value = "circuit-open";
      return this.routeToFallback(
        primary,
        request,
        "circuit-open",
        tried,
        new CircuitOpenError(this.circuitOpenMessage(primary)),
        providerUsedOut,
        decisionRef
      );
    }

    try {
      const response = await this.timedCall(primary, request, false, decisionRef);
      if (providerUsedOut) providerUsedOut.value = primary;
      return response;
    } catch (primaryError) {
      decisionRef.value = "call-failed";
      return this.routeToFallback(primary, request, "call-failed", tried, primaryError, providerUsedOut, decisionRef);
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
    errorIfUnusable: unknown,
    providerUsedOut?: { value?: ProviderName },
    decisionRef?: DecisionRef
  ): Promise<BrainResponse> {
    const fallback = this.resolveFallback(primary, request);
    if (!fallback) throw errorIfUnusable;

    // applyBudget may itself throw (BudgetExceededError/ZeroCostModeError/
    // RunBudgetExceededError) — that's a more specific, more useful error
    // than errorIfUnusable and is allowed to propagate as-is.
    const actualFallback = this.applyBudget(fallback, request, tried, decisionRef);
    tried.add(actualFallback);
    if (this.effectiveCircuitState(actualFallback) === "open") throw errorIfUnusable;

    this.options.eventBus?.emit("ai.providerFallback", { from: primary, to: actualFallback, reason });
    const response = await this.timedCall(actualFallback, request, true, decisionRef);
    if (providerUsedOut) providerUsedOut.value = actualFallback;
    return response;
  }

  private async timedCall(
    provider: ProviderName,
    request: BrainRequest,
    isFallback = false,
    decisionRef?: DecisionRef
  ): Promise<BrainResponse> {
    const wasHalfOpenTrial = this.effectiveCircuitState(provider) === "half-open";
    const start = performance.now();
    try {
      const response = await this.registry.get(provider)!.chat(request);
      const latencyMs = performance.now() - start;
      this.recordOutcome(provider, true, latencyMs, wasHalfOpenTrial);
      this.recordCost(provider, response, request, latencyMs, isFallback, decisionRef?.value ?? "primary-default");
      return response;
    } catch (err) {
      this.recordOutcome(provider, false, performance.now() - start, wasHalfOpenTrial);
      throw err;
    }
  }

  /**
   * Resolves this request's primary provider, plus the real, honest reason
   * THIS primary was picked — "why did you use this model?" decision
   * metadata (see `ProviderDecisionReason`'s own doc comment).
   *
   * Fallback Correctness: when `request` needs vision, only ever
   * considers providers whose `ModelCatalog` entry claims vision support
   * — cost-tier preference still applies *within* that capable subset
   * (free-first is tried first among capable providers). Throws
   * `NoCapableProviderError` if the request needs vision and *no*
   * configured provider can serve it at all, rather than silently
   * sending the image to a text-only model. An explicit
   * `options.explicitProvider` still always wins, same as before this
   * capability check existed — a deliberate operator choice isn't
   * second-guessed here: an explicit choice and a hard vision requirement
   * both take precedence over the "no-story" free-first/default cases.
   */
  private resolvePrimaryWithReason(request: BrainRequest): { provider: ProviderName; reason: ProviderDecisionReason } {
    if (this.options.explicitProvider && this.registry.has(this.options.explicitProvider)) {
      return { provider: this.options.explicitProvider, reason: "primary-explicit" };
    }

    if (requestNeedsVision(request)) {
      const visionCapable = this.registry.listConfigured().filter((name) => providerSupportsVision(name));
      if (visionCapable.length === 0) {
        throw new NoCapableProviderError(
          "This request includes an attached image, but no configured AI provider's model supports vision " +
            "(per ModelCatalog) — refusing rather than silently sending the image to a text-only model."
        );
      }
      if (this.freeFirst) {
        const freeVisionCapable = visionCapable.find((name) => this.registry.getMeta(name)?.costTier === "free");
        if (freeVisionCapable) return { provider: freeVisionCapable, reason: "vision-required" };
      }
      return { provider: visionCapable[0]!, reason: "vision-required" };
    }

    if (this.freeFirst) {
      const free = this.registry.findByCostTier("free")[0];
      if (free) return { provider: free, reason: "primary-free-first" };
    }

    if (this.registry.has("anthropic")) return { provider: "anthropic", reason: "primary-default" };
    if (this.registry.has("groq")) return { provider: "groq", reason: "primary-default" };
    // The constructor already guarantees at least one provider is
    // registered, so this is always defined in practice.
    return { provider: this.registry.listConfigured()[0]!, reason: "primary-default" };
  }

  /**
   * Fallback Correctness: a candidate that lacks a capability `request`
   * actually needs (today: vision) is never picked as a fallback,
   * including an explicit `fallbackProvider` override — it's skipped in
   * favor of another configured provider that does have it, or, if none
   * does, `routeToFallback` throws the original error instead of
   * silently degrading to a broken/incomplete response.
   */
  private resolveFallback(primary: ProviderName, request: BrainRequest): ProviderName | undefined {
    const needsVision = requestNeedsVision(request);
    const isCapable = (name: ProviderName) => !needsVision || providerSupportsVision(name);

    if (
      this.options.fallbackProvider &&
      this.options.fallbackProvider !== primary &&
      this.registry.has(this.options.fallbackProvider) &&
      isCapable(this.options.fallbackProvider)
    ) {
      return this.options.fallbackProvider;
    }
    return this.registry.listConfigured().find((name) => name !== primary && isCapable(name));
  }

  /**
   * Model Escalation: the strongest other *configured* provider (by
   * `ModelCatalog` `quality`) that is genuinely stronger than `exclude`
   * — never a lateral or weaker pick, and never `exclude` itself.
   * `zeroCostMode`/budget enforcement happens separately, in
   * `applyBudget`, after this — this only answers "which provider would
   * be the escalation target if we could afford it".
   */
  private resolveEscalationCandidate(exclude: ProviderName, request: BrainRequest): ProviderName | undefined {
    const excludeQuality = maxQualityForProvider(exclude);
    const needsVision = requestNeedsVision(request);
    const stronger = this.registry
      .listConfigured()
      .filter(
        (name) =>
          name !== exclude && maxQualityForProvider(name) > excludeQuality && (!needsVision || providerSupportsVision(name))
      );
    if (stronger.length === 0) return undefined;
    return stronger.reduce((best, name) => (maxQualityForProvider(name) > maxQualityForProvider(best) ? name : best));
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
  private applyBudget(
    candidate: ProviderName,
    request: BrainRequest,
    alreadyTried: ReadonlySet<ProviderName> = new Set(),
    decisionRef?: DecisionRef
  ): ProviderName {
    const meta = this.registry.getMeta(candidate);
    if (!meta || meta.costTier !== "paid") return candidate;

    if (this.options.zeroCostMode) {
      const free = this.registry.findByCostTier("free").find((name) => !alreadyTried.has(name));
      if (free) {
        this.options.eventBus?.emit("ai.providerFallback", { from: candidate, to: free, reason: "zero-cost-mode" });
        if (decisionRef) decisionRef.value = "zero-cost-mode";
        return free;
      }

      const noneConfiguredAtAll = this.registry.findByCostTier("free").length === 0;
      throw new ZeroCostModeError(
        noneConfiguredAtAll
          ? `ZERO_COST_MODE is enabled and no free-tier provider is configured at all — refusing to call the paid "${candidate}" provider. Chat capability is unavailable until a free-tier provider (e.g. GROQ_API_KEY) is configured or ZERO_COST_MODE is disabled.`
          : `ZERO_COST_MODE is enabled and the free-tier provider(s) available for this request already failed or are unavailable — refusing to call the paid "${candidate}" provider. Chat capability is unavailable for this request.`
      );
    }

    // Denial-of-wallet protection: a hard per-run ceiling, checked before
    // the softer daily/monthly caps below — a single runaway run/task can
    // otherwise burn well past what's reasonable for one turn while the
    // account-wide daily/monthly totals are still nowhere near their cap.
    if (this.options.maxCostPerRunUsd !== undefined && request.runId) {
      const runSpend = this.costTracker.getRunSpend(request.runId);
      if (runSpend >= this.options.maxCostPerRunUsd) {
        const free = this.registry.findByCostTier("free").find((name) => !alreadyTried.has(name));
        if (free) {
          this.options.eventBus?.emit("ai.providerFallback", { from: candidate, to: free, reason: "run-budget-exceeded" });
          if (decisionRef) decisionRef.value = "run-budget-exceeded";
          return free;
        }
        throw new RunBudgetExceededError(
          `This run's cost ceiling ($${this.options.maxCostPerRunUsd}) has already been reached ` +
            `(spent $${runSpend.toFixed(4)} so far this run) and no free-tier provider is available to fall back to — ` +
            `refusing to call the paid "${candidate}" provider for the rest of this run.`
        );
      }
    }

    const dailyExceeded =
      this.options.maxDailyCostUsd !== undefined && this.costTracker.getTodaySpend() >= this.options.maxDailyCostUsd;
    const monthlyExceeded =
      this.options.maxMonthlyCostUsd !== undefined &&
      this.costTracker.getMonthSpend() >= this.options.maxMonthlyCostUsd;

    if (!dailyExceeded && !monthlyExceeded) {
      // Budget-constrained degradation: not over the hard cap, but close
      // to it — bias toward a free provider now rather than waiting for
      // the cap to actually be hit. A soft nudge, never a hard failure:
      // if no free provider is available this just falls through to using
      // `candidate` as normal, same as today.
      const softCapFree = this.softCapFreeProvider(alreadyTried);
      if (softCapFree) {
        this.options.eventBus?.emit("ai.providerFallback", { from: candidate, to: softCapFree, reason: "soft-budget-cap" });
        if (decisionRef) decisionRef.value = "soft-budget-cap";
        return softCapFree;
      }
      return candidate;
    }

    const free = this.registry.findByCostTier("free")[0];
    if (free) {
      this.options.eventBus?.emit("ai.providerFallback", { from: candidate, to: free, reason: "budget-exceeded" });
      if (decisionRef) decisionRef.value = "budget-exceeded";
      return free;
    }

    const period = dailyExceeded ? "daily" : "monthly";
    throw new BudgetExceededError(
      `AI ${period} budget exceeded and no free-tier provider is configured to fall back to — refusing to call the paid "${candidate}" provider.`
    );
  }

  /**
   * Budget-constrained degradation: returns an untried free provider if
   * today's or this month's spend has crossed `softBudgetCapRatio` of its
   * configured cap, or undefined if neither cap is configured, the ratio
   * disables the feature (>= 1), spend is still comfortably under both,
   * or no free provider is available to swap to.
   */
  private softCapFreeProvider(alreadyTried: ReadonlySet<ProviderName>): ProviderName | undefined {
    const ratio = this.options.softBudgetCapRatio ?? DEFAULT_SOFT_BUDGET_CAP_RATIO;
    if (ratio >= 1) return undefined;

    const dailyClose =
      this.options.maxDailyCostUsd !== undefined && this.costTracker.getTodaySpend() >= this.options.maxDailyCostUsd * ratio;
    const monthlyClose =
      this.options.maxMonthlyCostUsd !== undefined &&
      this.costTracker.getMonthSpend() >= this.options.maxMonthlyCostUsd * ratio;
    if (!dailyClose && !monthlyClose) return undefined;

    return this.registry.findByCostTier("free").find((name) => !alreadyTried.has(name));
  }

  private recordCost(
    provider: ProviderName,
    response: BrainResponse,
    request: BrainRequest,
    latencyMs: number,
    isFallback: boolean,
    decisionReason: ProviderDecisionReason
  ): void {
    // Failed calls aren't recorded: a call that errors (network failure,
    // 429/5xx) is the common case where no tokens were actually billed,
    // and without a response there's no usage data to estimate from
    // anyway — recording a guessed cost for it would be less honest than
    // recording nothing.
    const cost = estimateCostUsd(provider, response.usage);
    this.costTracker.record(provider, cost, undefined, {
      model: response.model,
      usage: response.usage,
      runId: request.runId,
      latencyMs,
      toolCallCount: response.toolCalls.length,
      fallback: isFallback,
      taskType: request.taskType,
      decisionReason,
    });
    if (request.runId) this.costTracker.recordRunCost(request.runId, cost);
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
