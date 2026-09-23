import { describe, test, expect } from "bun:test";
import {
  AIRouter,
  BudgetExceededError,
  ZeroCostModeError,
  CircuitOpenError,
  RunBudgetExceededError,
  NoCapableProviderError,
} from "@/core/brain/AIRouter";
import { AIProviderRegistry } from "@/core/brain/AIProviderRegistry";
import { CostTracker } from "@/core/cost/CostTracker";
import { EventBus } from "@/core/events/EventBus";
import type { Brain, BrainRequest, BrainResponse } from "@/types/brain";

const REQUEST: BrainRequest = { messages: [], tools: [] };
const IMAGE_REQUEST: BrainRequest = {
  messages: [{ role: "user", content: "what's in this photo?", images: [{ mediaType: "image/png", data: "abc123" }] }],
  tools: [],
};

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

function streamingBrain(text: string, deltas: string[]): Brain {
  return {
    async chat(): Promise<BrainResponse> {
      return { text, toolCalls: [], stopReason: "stop" };
    },
    async chatStream(_request, onTextDelta): Promise<BrainResponse> {
      for (const delta of deltas) onTextDelta(delta);
      return { text, toolCalls: [], stopReason: "stop" };
    },
  };
}

describe("AIRouter.chatStream", () => {
  test("forwards deltas from a provider that supports chatStream", async () => {
    const registry = new AIProviderRegistry();
    registry.register("anthropic", streamingBrain("Hello, world.", ["Hel", "lo, ", "world."]), "paid");
    const costTracker = new CostTracker(":memory:");
    const router = new AIRouter(registry, costTracker, {});

    const received: string[] = [];
    const response = await router.chatStream(REQUEST, (d) => received.push(d));

    expect(received).toEqual(["Hel", "lo, ", "world."]);
    expect(response.text).toBe("Hello, world.");
  });

  test("falls back to a single whole-text delta for a provider with no chatStream", async () => {
    const registry = new AIProviderRegistry();
    registry.register("groq", okBrain("plain reply"), "free");
    const costTracker = new CostTracker(":memory:");
    const router = new AIRouter(registry, costTracker, {});

    const received: string[] = [];
    const response = await router.chatStream(REQUEST, (d) => received.push(d));

    expect(received).toEqual(["plain reply"]);
    expect(response.text).toBe("plain reply");
  });

  test("a failing stream propagates the error, same as chat()", async () => {
    const registry = new AIProviderRegistry();
    registry.register("anthropic", failingBrain("stream broke"), "paid");
    const costTracker = new CostTracker(":memory:");
    const router = new AIRouter(registry, costTracker, {});

    await expect(router.chatStream(REQUEST, () => {})).rejects.toThrow("stream broke");
  });

  test("records cost for a streamed response same as a non-streamed one", async () => {
    const registry = new AIProviderRegistry();
    registry.register("anthropic", streamingBrain("hi", ["hi"]), "paid");
    const costTracker = new CostTracker(":memory:");
    const router = new AIRouter(registry, costTracker, {});

    await router.chatStream(REQUEST, () => {});
    // Confirms recordCost actually ran (a paid provider still gets a
    // nonzero estimate even with no usage data on the mock response) —
    // it never silently skips cost tracking for the streaming path.
    expect(costTracker.getTodaySpend()).toBeGreaterThan(0);
  });
});

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

    test("excludes an already-tried free provider from the hard-budget-exceeded fallback, trying a different free provider instead", async () => {
      const registry = new AIProviderRegistry();
      registry.register("groq", failingBrain("groq down"), "free");
      registry.register("anthropic", okBrain("paid reply — should never be used"), "paid");
      registry.register("openrouter", okBrain("openrouter reply"), "free");
      const costTracker = new CostTracker(":memory:");
      costTracker.record("anthropic", 10); // already over the daily cap below
      const router = new AIRouter(registry, costTracker, { freeFirst: true, maxDailyCostUsd: 5 });

      // Primary (free-first) is groq, which fails; routeToFallback resolves
      // anthropic (paid) as the fallback candidate, but the daily cap is
      // exceeded — applyBudget must not hand back groq (already tried and
      // already failed this same request) as the "free" substitute.
      const response = await router.chat(REQUEST);
      expect(response.text).toBe("openrouter reply");
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

  describe("budget-constrained degradation (soft cap)", () => {
    test("biases toward a free provider once spend crosses the default 80% soft cap, below the hard cap", async () => {
      const registry = new AIProviderRegistry();
      const calls: string[] = [];
      registry.register("anthropic", countingBrain("paid reply", calls, "anthropic"), "paid");
      registry.register("groq", countingBrain("free reply", calls, "groq"), "free");
      const costTracker = new CostTracker(":memory:");
      costTracker.record("anthropic", 4.5); // 90% of a $5 daily cap — over the 80% soft threshold, under the hard cap
      const router = new AIRouter(registry, costTracker, { explicitProvider: "anthropic", maxDailyCostUsd: 5 });

      const response = await router.chat(REQUEST);
      expect(response.text).toBe("free reply");
      expect(calls).toEqual(["groq"]);
    });

    test("emits ai.providerFallback with reason 'soft-budget-cap'", async () => {
      const registry = new AIProviderRegistry();
      registry.register("anthropic", okBrain("paid reply"), "paid");
      registry.register("groq", okBrain("free reply"), "free");
      const costTracker = new CostTracker(":memory:");
      costTracker.record("anthropic", 4.5);
      const eventBus = new EventBus();
      const events: Array<{ from: string; to: string; reason: string }> = [];
      eventBus.on("ai.providerFallback", (payload) => events.push(payload));
      const router = new AIRouter(registry, costTracker, {
        explicitProvider: "anthropic",
        maxDailyCostUsd: 5,
        eventBus,
      });

      await router.chat(REQUEST);
      expect(events).toEqual([{ from: "anthropic", to: "groq", reason: "soft-budget-cap" }]);
    });

    test("does not bias below the soft cap threshold — paid provider is used as normal", async () => {
      const registry = new AIProviderRegistry();
      registry.register("anthropic", okBrain("paid reply"), "paid");
      registry.register("groq", okBrain("free reply"), "free");
      const costTracker = new CostTracker(":memory:");
      costTracker.record("anthropic", 1); // 20% of a $5 cap — well under the 80% threshold
      const router = new AIRouter(registry, costTracker, { explicitProvider: "anthropic", maxDailyCostUsd: 5 });

      const response = await router.chat(REQUEST);
      expect(response.text).toBe("paid reply");
    });

    test("a softBudgetCapRatio >= 1 disables the feature entirely", async () => {
      const registry = new AIProviderRegistry();
      registry.register("anthropic", okBrain("paid reply"), "paid");
      registry.register("groq", okBrain("free reply"), "free");
      const costTracker = new CostTracker(":memory:");
      costTracker.record("anthropic", 4.9); // 98% of the cap — would trigger the default soft cap
      const router = new AIRouter(registry, costTracker, {
        explicitProvider: "anthropic",
        maxDailyCostUsd: 5,
        softBudgetCapRatio: 1,
      });

      const response = await router.chat(REQUEST);
      expect(response.text).toBe("paid reply");
    });

    test("falls through to the paid candidate as normal when no free provider is configured to swap to", async () => {
      const registry = new AIProviderRegistry();
      registry.register("anthropic", okBrain("paid reply"), "paid");
      const costTracker = new CostTracker(":memory:");
      costTracker.record("anthropic", 4.5);
      const router = new AIRouter(registry, costTracker, { maxDailyCostUsd: 5 });

      const response = await router.chat(REQUEST);
      expect(response.text).toBe("paid reply");
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

    test("passes the full ledger — model, usage, runId, latency, toolCallCount, taskType — through to CostTracker", async () => {
      const registry = new AIProviderRegistry();
      registry.register(
        "anthropic",
        {
          async chat(): Promise<BrainResponse> {
            return {
              text: "reply",
              toolCalls: [{ id: "1", toolName: "SOME_TOOL", input: {} }],
              stopReason: "stop",
              usage: { inputTokens: 100, outputTokens: 20, cacheCreationInputTokens: 0, cacheReadInputTokens: 10 },
              model: "claude-sonnet-4-5-20250929",
            };
          },
        },
        "paid"
      );
      const costTracker = new CostTracker(":memory:");
      const router = new AIRouter(registry, costTracker, {});

      await router.chat({ messages: [], tools: [], runId: "run-abc", taskType: "chat" });

      const [record] = costTracker.listRecent(1);
      expect(record).toMatchObject({
        provider: "anthropic",
        model: "claude-sonnet-4-5-20250929",
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 10,
        runId: "run-abc",
        toolCallCount: 1,
        fallback: false,
        taskType: "chat",
      });
      expect(record!.latencyMs).toBeGreaterThanOrEqual(0);
    });

    test("marks a fallback-provider call's ledger record with fallback: true", async () => {
      const registry = new AIProviderRegistry();
      registry.register("anthropic", failingBrain("primary down"), "paid");
      registry.register("groq", okBrain("free reply"), "free");
      const costTracker = new CostTracker(":memory:");
      const router = new AIRouter(registry, costTracker, { explicitProvider: "anthropic" });

      await router.chat(REQUEST);

      const [record] = costTracker.listRecent(1);
      expect(record!.provider).toBe("groq");
      expect(record!.fallback).toBe(true);
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

    test("a genuinely unreachable Ollama server (connection refused) opens its circuit and routes around it, without blocking other providers", async () => {
      // Real OllamaBrain, not a stub — proves AIRouter's circuit breaker
      // handles OllamaBrain's actual thrown error shape (see
      // OllamaBrain.test.ts's "connection refused" test) gracefully, since
      // an offline/unreachable local Ollama server is a far more likely
      // real-world scenario for this provider than for a hosted one (the
      // user hasn't run `ollama serve`, or JARVIS's backend simply can't
      // reach it — see OllamaBrain's own doc comment on the
      // localhost/network-reachability caveat).
      const { OllamaBrain } = await import("@/core/brain/OllamaBrain");
      const originalFetch = global.fetch;
      global.fetch = (async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
      }) as unknown as typeof fetch;

      try {
        const registry = new AIProviderRegistry();
        const calls: string[] = [];
        registry.register("ollama", new OllamaBrain(undefined, { model: "qwen2.5", retryDelayMs: 0 }), "free");
        registry.register("anthropic", countingBrain("paid reply", calls, "anthropic"), "paid");
        const costTracker = new CostTracker(":memory:");
        const router = new AIRouter(registry, costTracker, {
          freeFirst: true,
          circuitBreakerThreshold: 2,
          circuitBreakerCooldownMs: 60_000,
        });

        // 1st and 2nd calls: ollama fails (unreachable), falls back to
        // anthropic each time — the turn itself still succeeds.
        const first = await router.chat(REQUEST);
        expect(first.text).toBe("paid reply");
        const second = await router.chat(REQUEST);
        expect(second.text).toBe("paid reply");
        expect(calls.filter((c) => c === "anthropic").length).toBe(2);

        // 3rd call: ollama's circuit is now open — routing skips it
        // entirely (as if unconfigured) rather than trying to reach the
        // dead server again, and anthropic still serves the request.
        calls.length = 0;
        const third = await router.chat(REQUEST);
        expect(third.text).toBe("paid reply");
        expect(calls).toEqual(["anthropic"]);

        const status = router.getProviderStatus();
        expect(status.ollama!.circuitOpen).toBe(true);
        expect(status.ollama!.consecutiveFailures).toBeGreaterThanOrEqual(2);
        // The other provider is entirely unaffected by ollama's outage.
        expect(status.anthropic!.circuitOpen).toBe(false);
      } finally {
        global.fetch = originalFetch;
      }
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

  describe("ZERO_COST_MODE adversarial — combined with Model Escalation", () => {
    test("chatWithEscalation never reaches the paid provider when every free provider fails, even on a validation-failure retry", async () => {
      const registry = new AIProviderRegistry();
      const calls: string[] = [];
      // The only free provider always "succeeds" but with a response the
      // caller's validator rejects — simulating a malformed/empty
      // structured response, exactly the case chatWithEscalation exists
      // for. If ZERO_COST_MODE had any gap, this is where it would show:
      // escalation would try to reach for the paid provider next.
      registry.register(
        "groq",
        {
          async chat(): Promise<BrainResponse> {
            calls.push("groq");
            return { text: "not json", toolCalls: [], stopReason: "stop" };
          },
        },
        "free"
      );
      registry.register("anthropic", countingBrain("paid reply", calls, "anthropic"), "paid");
      const costTracker = new CostTracker(":memory:");
      const router = new AIRouter(registry, costTracker, { zeroCostMode: true, freeFirst: true });

      const response = await router.chatWithEscalation(REQUEST, (r) => r.text === "valid");

      // The invalid-but-only-affordable response is returned as-is —
      // never an exception, never a silent reach for the paid provider.
      expect(response.text).toBe("not json");
      expect(calls).toEqual(["groq"]);
      expect(costTracker.getTodaySpend()).toBe(0);
    });

    test("chatWithEscalation throws ZeroCostModeError (not silently degrading) when the primary call itself fails and no free fallback exists", async () => {
      const registry = new AIProviderRegistry();
      const calls: string[] = [];
      registry.register("groq", failingBrain("groq down"), "free");
      registry.register("anthropic", countingBrain("paid reply", calls, "anthropic"), "paid");
      const costTracker = new CostTracker(":memory:");
      const router = new AIRouter(registry, costTracker, { zeroCostMode: true, freeFirst: true });

      // The primary call itself throws (not a validation failure) — this
      // goes through the ordinary fallback path inside chatInternal, which
      // ZERO_COST_MODE must still gate identically whether reached via
      // chat() or chatWithEscalation().
      await expect(router.chatWithEscalation(REQUEST, () => true)).rejects.toThrow(ZeroCostModeError);
      expect(calls).toEqual([]);
    });
  });

  describe("Denial-of-wallet protection — per-run cost ceiling", () => {
    test("falls back to the free provider once a run's own spend reaches maxCostPerRunUsd, even though the daily cap is nowhere near exceeded", async () => {
      const registry = new AIProviderRegistry();
      const calls: string[] = [];
      registry.register("anthropic", countingBrain("paid reply", calls, "anthropic"), "paid");
      registry.register("groq", countingBrain("free reply", calls, "groq"), "free");
      const costTracker = new CostTracker(":memory:");
      const router = new AIRouter(registry, costTracker, {
        explicitProvider: "anthropic",
        maxCostPerRunUsd: 0.01,
        maxDailyCostUsd: 1000,
      });
      const request: BrainRequest = { messages: [], tools: [], runId: "run-1" };

      // Pre-seed run-1's accumulator past the ceiling directly via the
      // same CostTracker the router reads from.
      costTracker.recordRunCost("run-1", 0.02);

      const response = await router.chat(request);
      expect(response.text).toBe("free reply");
      expect(calls).toEqual(["groq"]);
    });

    test("throws RunBudgetExceededError when the run ceiling is hit and no free provider is configured", async () => {
      const registry = new AIProviderRegistry();
      registry.register("anthropic", okBrain("paid reply"), "paid");
      const costTracker = new CostTracker(":memory:");
      costTracker.recordRunCost("run-2", 5);
      const router = new AIRouter(registry, costTracker, { maxCostPerRunUsd: 5 });

      await expect(router.chat({ messages: [], tools: [], runId: "run-2" })).rejects.toThrow(RunBudgetExceededError);
    });

    test("a different run's spend never counts against this run's ceiling", async () => {
      const registry = new AIProviderRegistry();
      registry.register("anthropic", okBrain("paid reply"), "paid");
      const costTracker = new CostTracker(":memory:");
      costTracker.recordRunCost("other-run", 100); // way over any reasonable ceiling
      const router = new AIRouter(registry, costTracker, { maxCostPerRunUsd: 1 });

      const response = await router.chat({ messages: [], tools: [], runId: "this-run" });
      expect(response.text).toBe("paid reply");
    });

    test("accumulates real spend across multiple calls sharing a runId and eventually trips the ceiling", async () => {
      const registry = new AIProviderRegistry();
      const calls: string[] = [];
      registry.register(
        "anthropic",
        {
          async chat(): Promise<BrainResponse> {
            calls.push("anthropic");
            return {
              text: "paid reply",
              toolCalls: [],
              stopReason: "stop",
              usage: { inputTokens: 1_000_000, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
            };
          },
        },
        "paid"
      );
      registry.register("groq", countingBrain("free reply", calls, "groq"), "free");
      const costTracker = new CostTracker(":memory:");
      // $3/M input tokens (see CostTracker) -> each call costs $3. The
      // ceiling is checked against spend *so far* (before this call), so
      // the 1st call (spend=0) still goes through paid; only once that
      // $3 is actually recorded does the 2nd call's check see spend >= 3.
      const router = new AIRouter(registry, costTracker, { explicitProvider: "anthropic", maxCostPerRunUsd: 3 });
      const request: BrainRequest = { messages: [], tools: [], runId: "run-3" };

      const first = await router.chat(request); // spend was $0 before this call -> allowed; now $3 spent this run
      expect(first.text).toBe("paid reply");

      const second = await router.chat(request); // spend is $3 >= $3 ceiling -> falls back to free
      expect(second.text).toBe("free reply");
      expect(calls).toEqual(["anthropic", "groq"]);
    });

    test("ZERO_COST_MODE still wins over maxCostPerRunUsd — never reaches the paid provider even before the run ceiling is hit", async () => {
      const registry = new AIProviderRegistry();
      const calls: string[] = [];
      registry.register("anthropic", countingBrain("paid reply", calls, "anthropic"), "paid");
      registry.register("groq", countingBrain("free reply", calls, "groq"), "free");
      const costTracker = new CostTracker(":memory:");
      const router = new AIRouter(registry, costTracker, {
        explicitProvider: "anthropic",
        zeroCostMode: true,
        maxCostPerRunUsd: 1000, // nowhere near exceeded
      });

      const response = await router.chat({ messages: [], tools: [], runId: "run-4" });
      expect(response.text).toBe("free reply");
      expect(calls).toEqual(["groq"]);
    });

    test("a request with no runId is never subject to the per-run ceiling", async () => {
      const registry = new AIProviderRegistry();
      registry.register("anthropic", okBrain("paid reply"), "paid");
      const costTracker = new CostTracker(":memory:");
      const router = new AIRouter(registry, costTracker, { maxCostPerRunUsd: 0.0000001 });

      const response = await router.chat(REQUEST); // no runId
      expect(response.text).toBe("paid reply");
    });
  });

  describe("Model Escalation", () => {
    test("retries once against the stronger provider when the caller's deterministic validator rejects the first response", async () => {
      const registry = new AIProviderRegistry();
      const calls: string[] = [];
      registry.register("groq", countingBrain("not json", calls, "groq"), "free");
      registry.register("anthropic", countingBrain('["valid"]', calls, "anthropic"), "paid");
      const costTracker = new CostTracker(":memory:");
      const router = new AIRouter(registry, costTracker, { freeFirst: true });

      const response = await router.chatWithEscalation(REQUEST, (r) => r.text.startsWith("["));
      expect(response.text).toBe('["valid"]');
      expect(calls).toEqual(["groq", "anthropic"]);
    });

    test("does not escalate when the first response already passes validation", async () => {
      const registry = new AIProviderRegistry();
      const calls: string[] = [];
      registry.register("groq", countingBrain('["valid"]', calls, "groq"), "free");
      registry.register("anthropic", countingBrain('["should not be called"]', calls, "anthropic"), "paid");
      const costTracker = new CostTracker(":memory:");
      const router = new AIRouter(registry, costTracker, { freeFirst: true });

      const response = await router.chatWithEscalation(REQUEST, (r) => r.text.startsWith("["));
      expect(response.text).toBe('["valid"]');
      expect(calls).toEqual(["groq"]);
    });

    test("caps escalation at exactly one retry — a still-invalid escalated response is returned as-is, no further retry", async () => {
      const registry = new AIProviderRegistry();
      const calls: string[] = [];
      registry.register("groq", countingBrain("bad", calls, "groq"), "free");
      registry.register("anthropic", countingBrain("still bad", calls, "anthropic"), "paid");
      const costTracker = new CostTracker(":memory:");
      const router = new AIRouter(registry, costTracker, { freeFirst: true });

      const response = await router.chatWithEscalation(REQUEST, (r) => r.text === "never valid");
      expect(response.text).toBe("still bad");
      expect(calls).toEqual(["groq", "anthropic"]); // exactly one escalation call, not more
    });

    test("never escalates to a weaker or equal-quality provider", async () => {
      const registry = new AIProviderRegistry();
      const calls: string[] = [];
      // Both free providers rank "good" in ModelCatalog — neither is
      // "stronger" than the other, so an invalid groq response must not
      // trigger an openrouter call.
      registry.register("groq", countingBrain("bad", calls, "groq"), "free");
      registry.register("openrouter", countingBrain("also would be bad", calls, "openrouter"), "free");
      const costTracker = new CostTracker(":memory:");
      const router = new AIRouter(registry, costTracker, { explicitProvider: "groq" });

      const response = await router.chatWithEscalation(REQUEST, () => false);
      expect(response.text).toBe("bad");
      expect(calls).toEqual(["groq"]);
    });

    test("falls back to the original response, without throwing, when escalating would violate ZERO_COST_MODE", async () => {
      const registry = new AIProviderRegistry();
      const calls: string[] = [];
      registry.register("groq", countingBrain("bad", calls, "groq"), "free");
      registry.register("anthropic", countingBrain("would be better", calls, "anthropic"), "paid");
      const costTracker = new CostTracker(":memory:");
      const router = new AIRouter(registry, costTracker, { explicitProvider: "groq", zeroCostMode: true });

      const response = await router.chatWithEscalation(REQUEST, () => false);
      expect(response.text).toBe("bad");
      expect(calls).toEqual(["groq"]); // anthropic never touched
    });

    test("emits ai.escalation when it actually escalates", async () => {
      const registry = new AIProviderRegistry();
      registry.register("groq", okBrain("bad"), "free");
      registry.register("anthropic", okBrain("good"), "paid");
      const costTracker = new CostTracker(":memory:");
      const eventBus = new EventBus();
      const events: unknown[] = [];
      eventBus.on("ai.escalation", (payload) => events.push(payload));
      const router = new AIRouter(registry, costTracker, { freeFirst: true, eventBus });

      await router.chatWithEscalation(REQUEST, (r) => r.text === "good");
      expect(events).toEqual([{ from: "groq", to: "anthropic", reason: "validation-failed" }]);
    });
  });

  describe("Fallback Correctness — capability-aware routing", () => {
    test("picks the vision-capable paid provider as primary for an image request even with freeFirst on and a non-vision free provider configured", async () => {
      const registry = new AIProviderRegistry();
      const calls: string[] = [];
      registry.register("groq", countingBrain("free reply (no vision)", calls, "groq"), "free");
      registry.register("anthropic", countingBrain("paid reply (vision)", calls, "anthropic"), "paid");
      const costTracker = new CostTracker(":memory:");
      const router = new AIRouter(registry, costTracker, { freeFirst: true });

      const response = await router.chat(IMAGE_REQUEST);
      expect(response.text).toBe("paid reply (vision)");
      expect(calls).toEqual(["anthropic"]);
    });

    test("a text-only request is unaffected — still free-first as before", async () => {
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

    test("throws NoCapableProviderError for an image request when no configured provider supports vision", async () => {
      const registry = new AIProviderRegistry();
      registry.register("groq", okBrain("free reply"), "free");
      const costTracker = new CostTracker(":memory:");
      const router = new AIRouter(registry, costTracker, {});

      await expect(router.chat(IMAGE_REQUEST)).rejects.toThrow(NoCapableProviderError);
    });

    test("fallback-on-failure skips a non-vision-capable provider for an image request, and throws the original error instead of degrading", async () => {
      const registry = new AIProviderRegistry();
      const calls: string[] = [];
      registry.register("anthropic", failingBrain("anthropic down"), "paid");
      registry.register("groq", countingBrain("should never be reached", calls, "groq"), "free");
      const costTracker = new CostTracker(":memory:");
      const router = new AIRouter(registry, costTracker, { explicitProvider: "anthropic" });

      await expect(router.chat(IMAGE_REQUEST)).rejects.toThrow("anthropic down");
      expect(calls).toEqual([]); // groq (no vision) never called for an image request
    });

    test("an explicit provider still wins even for an image request it can't actually serve well (operator override respected)", async () => {
      const registry = new AIProviderRegistry();
      const calls: string[] = [];
      registry.register("groq", countingBrain("groq reply", calls, "groq"), "free");
      const costTracker = new CostTracker(":memory:");
      const router = new AIRouter(registry, costTracker, { explicitProvider: "groq" });

      const response = await router.chat(IMAGE_REQUEST);
      expect(response.text).toBe("groq reply");
      expect(calls).toEqual(["groq"]);
    });
  });
});
