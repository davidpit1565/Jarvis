import { describe, test, expect } from "bun:test";
import { AIRouter, BudgetExceededError, ZeroCostModeError, CircuitOpenError } from "@/core/brain/AIRouter";
import { AIProviderRegistry } from "@/core/brain/AIProviderRegistry";
import { CostTracker } from "@/core/cost/CostTracker";
import { EventBus } from "@/core/events/EventBus";
import type { Brain, BrainRequest, BrainResponse } from "@/types/brain";

const REQUEST: BrainRequest = { messages: [], tools: [] };

function okBrain(text: string, usage?: BrainResponse["usage"]): Brain {
  return {
    async chat(): Promise<BrainResponse> {
      return { text, toolCalls: [], stopReason: "stop", usage };
    },
  };
}

function failingBrain(message: string): Brain {
  return {
    async chat(): Promise<BrainResponse> {
      throw new Error(message);
    },
  };
}

function countingBrain(text: string, calls: string[], name: string): Brain {
  return {
    async chat(): Promise<BrainResponse> {
      calls.push(name);
      return { text, toolCalls: [], stopReason: "stop" };
    },
  };
}

/** A brain whose `chat()` behavior is controlled by a mutable flag/queue, for circuit-breaker tests that need several sequential calls to the same provider to behave differently. */
function scriptedBrain(script: Array<"ok" | "fail">): Brain {
  let i = 0;
  return {
    async chat(): Promise<BrainResponse> {
      const step = script[Math.min(i, script.length - 1)]!;
      i++;
      if (step === "fail") throw new Error(`scripted failure #${i}`);
      return { text: "ok", toolCalls: [], stopReason: "stop" };
    },
  };
}

describe("AIRouter", () => {
  test("throws immediately if no provider is registered", () => {
    const registry = new AIProviderRegistry();
    const costTracker = new CostTracker(":memory:");
    expect(() => new AIRouter(registry, costTracker, {})).toThrow();
  });

  describe("single-provider mode", () => {
    test("routes to the only configured provider without crashing", async () => {
      const registry = new AIProviderRegistry();
      registry.register("anthropic", okBrain("hello"), "paid");
      const costTracker = new CostTracker(":memory:");
      const router = new AIRouter(registry, costTracker, {});

      const response = await router.chat(REQUEST);
      expect(response.text).toBe("hello");
    });

    test("a single provider's failure propagates (no fallback exists)", async () => {
      const registry = new AIProviderRegistry();
      registry.register("anthropic", failingBrain("boom"), "paid");
      const costTracker = new CostTracker(":memory:");
      const router = new AIRouter(registry, costTracker, {});

      await expect(router.chat(REQUEST)).rejects.toThrow("boom");
    });

    test("records estimated cost for the single provider on success", async () => {
      const registry = new AIProviderRegistry();
      registry.register("groq", okBrain("hi"), "free");
      const costTracker = new CostTracker(":memory:");
      const router = new AIRouter(registry, costTracker, {});

      await router.chat(REQUEST);
      expect(costTracker.getTodaySpend()).toBe(0);
    });
  });

  describe("free-first mode", () => {
    test("prefers the free provider when both are configured and no explicit provider is set", async () => {
      const registry = new AIProviderRegistry();
      const calls: string[] = [];
      registry.register("groq", countingBrain("free reply", calls, "groq"), "free");
      registry.register("anthropic", countingBrain("paid reply", calls, "anthropic"), "paid");
      const costTracker = new CostTracker(":memory:");
      const router = new AIRouter(registry, costTracker, { freeFirst: true });

      const response = await router.chat(REQUEST);
      expect(response.text).toBe("free reply");
      expect(calls).toEqual(["groq"]);
    });

    test("uses the paid provider when freeFirst is false and no explicit provider is set", async () => {
      const registry = new AIProviderRegistry();
      registry.register("groq", okBrain("free reply"), "free");
      registry.register("anthropic", okBrain("paid reply"), "paid");
      const costTracker = new CostTracker(":memory:");
      const router = new AIRouter(registry, costTracker, { freeFirst: false });

      const response = await router.chat(REQUEST);
      expect(response.text).toBe("paid reply");
    });

    test("an explicit provider always wins over freeFirst", async () => {
      const registry = new AIProviderRegistry();
      registry.register("groq", okBrain("free reply"), "free");
      registry.register("anthropic", okBrain("paid reply"), "paid");
      const costTracker = new CostTracker(":memory:");
      const router = new AIRouter(registry, costTracker, { freeFirst: true, explicitProvider: "anthropic" });

      const response = await router.chat(REQUEST);
      expect(response.text).toBe("paid reply");
    });
  });

  describe("fallback on failure", () => {
    test("falls back to the other configured provider when the primary throws", async () => {
      const registry = new AIProviderRegistry();
      registry.register("groq", failingBrain("groq down"), "free");
      registry.register("anthropic", okBrain("paid reply"), "paid");
      const costTracker = new CostTracker(":memory:");
      const router = new AIRouter(registry, costTracker, { freeFirst: true });

      const response = await router.chat(REQUEST);
      expect(response.text).toBe("paid reply");
    });

    test("emits ai.providerFallback with reason call-failed", async () => {
      const registry = new AIProviderRegistry();
      registry.register("groq", failingBrain("groq down"), "free");
      registry.register("anthropic", okBrain("paid reply"), "paid");
      const costTracker = new CostTracker(":memory:");
      const eventBus = new EventBus();
      const events: unknown[] = [];
      eventBus.on("ai.providerFallback", (payload) => events.push(payload));
      const router = new AIRouter(registry, costTracker, { freeFirst: true, eventBus });

      await router.chat(REQUEST);
      expect(events).toEqual([{ from: "groq", to: "anthropic", reason: "call-failed" }]);
    });

    test("respects an explicit AI_FALLBACK_PROVIDER over whatever else is configured", async () => {
      const registry = new AIProviderRegistry();
      registry.register("anthropic", failingBrain("primary down"), "paid");
      registry.register("groq", okBrain("free fallback"), "free");
      const costTracker = new CostTracker(":memory:");
      const router = new AIRouter(registry, costTracker, {
        explicitProvider: "anthropic",
        fallbackProvider: "groq",
      });

      const response = await router.chat(REQUEST);
      expect(response.text).toBe("free fallback");
    });

    test("propagates the original error if the fallback also fails", async () => {
      const registry = new AIProviderRegistry();
      registry.register("groq", failingBrain("groq down"), "free");
      registry.register("anthropic", failingBrain("anthropic down"), "paid");
      const costTracker = new CostTracker(":memory:");
      const router = new AIRouter(registry, costTracker, { freeFirst: true });

      await expect(router.chat(REQUEST)).rejects.toThrow("anthropic down");
    });
  });

  describe("budget enforcement", () => {
    test("refuses the paid provider once the daily cap is met, using the free provider instead", async () => {
      const registry = new AIProviderRegistry();
      const calls: string[] = [];
      registry.register("anthropic", countingBrain("paid reply", calls, "anthropic"), "paid");
      registry.register("groq", countingBrain("free reply", calls, "groq"), "free");
      const costTracker = new CostTracker(":memory:");
      costTracker.record("anthropic", 5); // already at/above the cap below
      const router = new AIRouter(registry, costTracker, {
        explicitProvider: "anthropic",
        maxDailyCostUsd: 5,
      });

      const response = await router.chat(REQUEST);
      expect(response.text).toBe("free reply");
      expect(calls).toEqual(["groq"]);
    });

    test("throws BudgetExceededError when the cap is met and no free provider is configured", async () => {
      const registry = new AIProviderRegistry();
      registry.register("anthropic", okBrain("paid reply"), "paid");
      const costTracker = new CostTracker(":memory:");
      costTracker.record("anthropic", 10);
      const router = new AIRouter(registry, costTracker, { maxDailyCostUsd: 5 });

      await expect(router.chat(REQUEST)).rejects.toThrow(BudgetExceededError);
    });

    test("does not block a paid provider when spend is under the cap", async () => {
      const registry = new AIProviderRegistry();
      registry.register("anthropic", okBrain("paid reply"), "paid");
      const costTracker = new CostTracker(":memory:");
      costTracker.record("anthropic", 1);
      const router = new AIRouter(registry, costTracker, { maxDailyCostUsd: 5 });

      const response = await router.chat(REQUEST);
      expect(response.text).toBe("paid reply");
    });

    test("enforces the monthly cap the same way as the daily cap", async () => {
      const registry = new AIProviderRegistry();
      registry.register("anthropic", okBrain("paid reply"), "paid");
      const costTracker = new CostTracker(":memory:");
      costTracker.record("anthropic", 100);
      const router = new AIRouter(registry, costTracker, { maxMonthlyCostUsd: 50 });

      await expect(router.chat(REQUEST)).rejects.toThrow(BudgetExceededError);
    });

    test("never restricts a free provider, even past the cap", async () => {
      const registry = new AIProviderRegistry();
      registry.register("groq", okBrain("free reply"), "free");
      const costTracker = new CostTracker(":memory:");
      const router = new AIRouter(registry, costTracker, { maxDailyCostUsd: 0.0001 });

      const response = await router.chat(REQUEST);
      expect(response.text).toBe("free reply");
    });
  });

  describe("cost recording", () => {
    test("records the response's estimated cost after a successful call", async () => {
      const registry = new AIProviderRegistry();
      registry.register("anthropic", okBrain("paid reply", {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      }), "paid");
      const costTracker = new CostTracker(":memory:");
      const router = new AIRouter(registry, costTracker, {});

      await router.chat(REQUEST);
      expect(costTracker.getTodaySpend()).toBeCloseTo(3, 5); // $3/M input tokens
    });
  });

  describe("ZERO_COST_MODE", () => {
    test("routes to the free provider instead of an explicit paid one, without touching the paid provider", async () => {
      const registry = new AIProviderRegistry();
      const calls: string[] = [];
      registry.register("anthropic", countingBrain("paid reply", calls, "anthropic"), "paid");
      registry.register("groq", countingBrain("free reply", calls, "groq"), "free");
      const costTracker = new CostTracker(":memory:");
      const router = new AIRouter(registry, costTracker, {
        explicitProvider: "anthropic",
        zeroCostMode: true,
      });

      const response = await router.chat(REQUEST);
      expect(response.text).toBe("free reply");
      expect(calls).toEqual(["groq"]);
    });

    test("throws ZeroCostModeError (never calling the paid provider) when no free provider is configured at all", async () => {
      const registry = new AIProviderRegistry();
      const calls: string[] = [];
      registry.register("anthropic", countingBrain("paid reply", calls, "anthropic"), "paid");
      const costTracker = new CostTracker(":memory:");
      const router = new AIRouter(registry, costTracker, { zeroCostMode: true });

      await expect(router.chat(REQUEST)).rejects.toThrow(ZeroCostModeError);
      expect(calls).toEqual([]);
    });

    test("throws ZeroCostModeError (never falling through to paid) when the free provider fails and no other free provider exists", async () => {
      const registry = new AIProviderRegistry();
      const calls: string[] = [];
      registry.register("groq", (() => {
        return {
          async chat(): Promise<BrainResponse> {
            calls.push("groq");
            throw new Error("groq down");
          },
        };
      })(), "free");
      registry.register("anthropic", countingBrain("paid reply", calls, "anthropic"), "paid");
      const costTracker = new CostTracker(":memory:");
      const router = new AIRouter(registry, costTracker, { zeroCostMode: true, freeFirst: true });

      await expect(router.chat(REQUEST)).rejects.toThrow(ZeroCostModeError);
      // The free provider was tried (and failed) — the paid one never was.
      expect(calls).toEqual(["groq"]);
    });

    test("never restricts a free provider even in ZERO_COST_MODE", async () => {
      const registry = new AIProviderRegistry();
      registry.register("groq", okBrain("free reply"), "free");
      const costTracker = new CostTracker(":memory:");
      const router = new AIRouter(registry, costTracker, { zeroCostMode: true });

      const response = await router.chat(REQUEST);
      expect(response.text).toBe("free reply");
    });

    test("ZERO_COST_MODE is a hard boundary independent of the (unmet) budget caps", async () => {
      const registry = new AIProviderRegistry();
      const calls: string[] = [];
      registry.register("anthropic", countingBrain("paid reply", calls, "anthropic"), "paid");
      const costTracker = new CostTracker(":memory:");
      // Budget caps are nowhere near exceeded — but zero-cost mode still blocks.
      const router = new AIRouter(registry, costTracker, {
        zeroCostMode: true,
        maxDailyCostUsd: 1000,
        maxMonthlyCostUsd: 1000,
      });

      await expect(router.chat(REQUEST)).rejects.toThrow(ZeroCostModeError);
      expect(calls).toEqual([]);
    });
  });

  describe("circuit breaker", () => {
    test("opens a provider's circuit after N consecutive failures and routes around it", async () => {
      const registry = new AIProviderRegistry();
      const calls: string[] = [];
      registry.register("groq", scriptedBrain(["fail", "fail", "fail", "fail"]), "free");
      registry.register("anthropic", countingBrain("paid reply", calls, "anthropic"), "paid");
      const costTracker = new CostTracker(":memory:");
      const router = new AIRouter(registry, costTracker, {
        freeFirst: true,
        circuitBreakerThreshold: 2,
        circuitBreakerCooldownMs: 60_000,
      });

      // 1st call: groq fails (1 consecutive failure), falls back to anthropic.
      await router.chat(REQUEST);
      // 2nd call: groq fails again (2 consecutive failures -> circuit opens), falls back to anthropic.
      await router.chat(REQUEST);
      expect(calls.filter((c) => c === "anthropic").length).toBe(2);

      // 3rd call: groq's circuit is now open — routing must skip straight to
      // anthropic without ever invoking groq's chat() a third time.
      calls.length = 0;
      const response = await router.chat(REQUEST);
      expect(response.text).toBe("paid reply");
      expect(calls).toEqual(["anthropic"]);

      const status = router.getProviderStatus();
      expect(status.groq!.circuitOpen).toBe(true);
    });

    test("after the cooldown elapses, allows a half-open trial call that closes the circuit again on success", async () => {
      const registry = new AIProviderRegistry();
      const calls: string[] = [];
      registry.register("groq", scriptedBrain(["fail", "fail", "ok"]), "free");
      registry.register("anthropic", countingBrain("paid reply", calls, "anthropic"), "paid");
      const costTracker = new CostTracker(":memory:");
      const router = new AIRouter(registry, costTracker, {
        freeFirst: true,
        circuitBreakerThreshold: 2,
        circuitBreakerCooldownMs: 30,
      });

      await router.chat(REQUEST); // groq fails (1)
      await router.chat(REQUEST); // groq fails (2) -> circuit opens

      // Wait past the (1ms) cooldown so the next call is a half-open trial.
      await new Promise((resolve) => setTimeout(resolve, 60));

      const response = await router.chat(REQUEST); // groq succeeds -> circuit closes
      expect(response.text).toBe("ok");

      const status = router.getProviderStatus();
      expect(status.groq!.circuitOpen).toBe(false);
      expect(status.groq!.consecutiveFailures).toBe(0);
    });

    test("a failed half-open trial re-opens the circuit", async () => {
      const registry = new AIProviderRegistry();
      registry.register("groq", scriptedBrain(["fail", "fail", "fail", "fail"]), "free");
      const costTracker = new CostTracker(":memory:");
      const router = new AIRouter(registry, costTracker, {
        circuitBreakerThreshold: 2,
        circuitBreakerCooldownMs: 30,
      });

      await expect(router.chat(REQUEST)).rejects.toThrow(); // failure 1
      await expect(router.chat(REQUEST)).rejects.toThrow(); // failure 2 -> opens
      expect(router.getProviderStatus().groq!.circuitOpen).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 60));

      // Half-open trial call fails -> circuit re-opens (single-provider setup,
      // so the call is still attempted and the error still propagates).
      await expect(router.chat(REQUEST)).rejects.toThrow();
      expect(router.getProviderStatus().groq!.circuitOpen).toBe(true);
    });

    test("an open circuit with no usable fallback throws CircuitOpenError", async () => {
      const registry = new AIProviderRegistry();
      registry.register("groq", scriptedBrain(["fail", "fail"]), "free");
      const costTracker = new CostTracker(":memory:");
      const router = new AIRouter(registry, costTracker, { circuitBreakerThreshold: 1 });

      await expect(router.chat(REQUEST)).rejects.toThrow(); // 1 failure -> circuit opens
      await expect(router.chat(REQUEST)).rejects.toThrow(CircuitOpenError); // circuit open, no fallback, never even calls groq again
    });

    test("a success resets the consecutive-failure count", async () => {
      const registry = new AIProviderRegistry();
      registry.register("groq", scriptedBrain(["fail", "ok", "fail", "ok"]), "free");
      const costTracker = new CostTracker(":memory:");
      const router = new AIRouter(registry, costTracker, { circuitBreakerThreshold: 2 });

      await expect(router.chat(REQUEST)).rejects.toThrow(); // 1 failure
      await router.chat(REQUEST); // success -> resets to 0
      expect(router.getProviderStatus().groq!.consecutiveFailures).toBe(0);
      await expect(router.chat(REQUEST)).rejects.toThrow(); // 1 failure again (not 3rd consecutive)
      expect(router.getProviderStatus().groq!.circuitOpen).toBe(false); // threshold is 2, only 1 consecutive failure
    });
  });

  describe("getProviderStatus", () => {
    test("only lists configured providers, with circuitOpen false and no samples before any call", () => {
      const registry = new AIProviderRegistry();
      registry.register("groq", okBrain("hi"), "free");
      const costTracker = new CostTracker(":memory:");
      const router = new AIRouter(registry, costTracker, {});

      const status = router.getProviderStatus();
      expect(Object.keys(status)).toEqual(["groq"]);
      expect(status.groq).toEqual({
        configured: true,
        costTier: "free",
        circuitOpen: false,
        consecutiveFailures: 0,
        latencyMs: undefined,
        averageLatencyMs: undefined,
        successRate: undefined,
        sampleSize: 0,
      });
    });

    test("records latency and success rate for both successful and failed calls", async () => {
      const registry = new AIProviderRegistry();
      registry.register("groq", scriptedBrain(["ok", "fail", "ok"]), "free");
      const costTracker = new CostTracker(":memory:");
      const router = new AIRouter(registry, costTracker, { circuitBreakerThreshold: 100 });

      await router.chat(REQUEST);
      await expect(router.chat(REQUEST)).rejects.toThrow();
      await router.chat(REQUEST);

      const status = router.getProviderStatus().groq!;
      expect(status.sampleSize).toBe(3);
      expect(status.successRate).toBeCloseTo(2 / 3, 5);
      expect(typeof status.latencyMs).toBe("number");
      expect(status.latencyMs).toBeGreaterThanOrEqual(0);
      expect(typeof status.averageLatencyMs).toBe("number");
      expect(status.averageLatencyMs).toBeGreaterThanOrEqual(0);
    });

    test("reports each configured provider's costTier", () => {
      const registry = new AIProviderRegistry();
      registry.register("groq", okBrain("hi"), "free");
      registry.register("anthropic", okBrain("hi"), "paid");
      const costTracker = new CostTracker(":memory:");
      const router = new AIRouter(registry, costTracker, {});

      const status = router.getProviderStatus();
      expect(status.groq!.costTier).toBe("free");
      expect(status.anthropic!.costTier).toBe("paid");
    });
  });
});
