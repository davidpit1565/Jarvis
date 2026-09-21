import { describe, test, expect } from "bun:test";
import { AIRouter, BudgetExceededError } from "@/core/brain/AIRouter";
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
});
