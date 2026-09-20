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
