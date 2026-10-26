import { describe, test, expect } from "bun:test";
import { AIProviderRegistry } from "@/core/brain/AIProviderRegistry";
import type { Brain, BrainRequest, BrainResponse } from "@/types/brain";

function stubBrain(text: string): Brain {
  return {
    async chat(_request: BrainRequest): Promise<BrainResponse> {
      return { text, toolCalls: [], stopReason: "stop" };
    },
  };
}

describe("AIProviderRegistry", () => {
  test("starts empty", () => {
    const registry = new AIProviderRegistry();
    expect(registry.listConfigured()).toEqual([]);
    expect(registry.list()).toEqual([]);
  });

  test("registers a provider and makes it retrievable", () => {
    const registry = new AIProviderRegistry();
    const brain = stubBrain("hi");
    registry.register("groq", brain, "free");

    expect(registry.has("groq")).toBe(true);
    expect(registry.has("anthropic")).toBe(false);
    expect(registry.get("groq")).toBe(brain);
    expect(registry.get("anthropic")).toBeUndefined();
  });

  test("tags metadata with the given cost tier and isConfigured true", () => {
    const registry = new AIProviderRegistry();
    registry.register("groq", stubBrain("hi"), "free");

    expect(registry.getMeta("groq")).toEqual({ name: "groq", costTier: "free", isConfigured: true });
    expect(registry.getMeta("anthropic")).toBeUndefined();
  });

  test("lists configured provider names in registration order", () => {
    const registry = new AIProviderRegistry();
    registry.register("groq", stubBrain("g"), "free");
    registry.register("anthropic", stubBrain("a"), "paid");

    expect(registry.listConfigured()).toEqual(["groq", "anthropic"]);
    expect(registry.list()).toEqual([
      { name: "groq", costTier: "free", isConfigured: true },
      { name: "anthropic", costTier: "paid", isConfigured: true },
    ]);
  });

  test("findByCostTier filters by tier", () => {
    const registry = new AIProviderRegistry();
    registry.register("groq", stubBrain("g"), "free");
    registry.register("anthropic", stubBrain("a"), "paid");

    expect(registry.findByCostTier("free")).toEqual(["groq"]);
    expect(registry.findByCostTier("paid")).toEqual(["anthropic"]);
  });

  test("supports registering openrouter as a third free-tier provider", () => {
    const registry = new AIProviderRegistry();
    registry.register("openrouter", stubBrain("or"), "free");

    expect(registry.has("openrouter")).toBe(true);
    expect(registry.getMeta("openrouter")).toEqual({ name: "openrouter", costTier: "free", isConfigured: true });
    expect(registry.findByCostTier("free")).toEqual(["openrouter"]);
  });

  test("findByCostTierPrioritized orders configured providers by the given priority list, not registration order", () => {
    const registry = new AIProviderRegistry();
    // Registered in an order that deliberately does NOT match the
    // priority list below, so a passing test can't be an accident of
    // registration order happening to agree with it.
    registry.register("groq", stubBrain("g"), "free");
    registry.register("openrouter", stubBrain("or"), "free");
    registry.register("gemini", stubBrain("gem"), "free");
    registry.register("anthropic", stubBrain("a"), "paid");

    expect(registry.findByCostTierPrioritized("free", ["gemini", "openrouter", "groq"])).toEqual([
      "gemini",
      "openrouter",
      "groq",
    ]);
  });

  test("findByCostTierPrioritized appends configured providers missing from the priority list, in registration order, instead of dropping them", () => {
    const registry = new AIProviderRegistry();
    registry.register("groq", stubBrain("g"), "free");
    registry.register("cloudflare-workers-ai", stubBrain("cf"), "free");
    registry.register("gemini", stubBrain("gem"), "free");

    // "cloudflare-workers-ai" isn't named in the priority list at all —
    // it must still show up, after every named provider.
    expect(registry.findByCostTierPrioritized("free", ["gemini", "groq"])).toEqual([
      "gemini",
      "groq",
      "cloudflare-workers-ai",
    ]);
  });

  test("findByCostTierPrioritized with an empty priority list behaves like plain registration order", () => {
    const registry = new AIProviderRegistry();
    registry.register("groq", stubBrain("g"), "free");
    registry.register("gemini", stubBrain("gem"), "free");

    expect(registry.findByCostTierPrioritized("free", [])).toEqual(["groq", "gemini"]);
  });

  test("re-registering the same name overwrites its brain and metadata", () => {
    const registry = new AIProviderRegistry();
    const first = stubBrain("first");
    const second = stubBrain("second");
    registry.register("groq", first, "free");
    registry.register("groq", second, "paid");

    expect(registry.get("groq")).toBe(second);
    expect(registry.getMeta("groq")?.costTier).toBe("paid");
    expect(registry.listConfigured()).toEqual(["groq"]);
  });
});
