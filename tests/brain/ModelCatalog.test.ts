import { describe, test, expect } from "bun:test";
import { MODEL_CATALOG, findModel, modelsForProvider, modelsByCostTier } from "@/core/brain/ModelCatalog";

describe("ModelCatalog", () => {
  test("every entry has a non-empty id, label, and notes", () => {
    for (const entry of MODEL_CATALOG) {
      expect(entry.id.length).toBeGreaterThan(0);
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.notes.length).toBeGreaterThan(0);
    }
  });

  test("findModel finds a known model by exact id", () => {
    const entry = findModel("claude-sonnet-4-5-20250929");
    expect(entry?.provider).toBe("anthropic");
    expect(entry?.costTier).toBe("paid");
  });

  test("findModel returns undefined for an unknown model id", () => {
    expect(findModel("not-a-real-model")).toBeUndefined();
  });

  test("modelsForProvider filters correctly", () => {
    const groqModels = modelsForProvider("groq");
    expect(groqModels.length).toBeGreaterThan(0);
    expect(groqModels.every((m) => m.provider === "groq")).toBe(true);
  });

  test("modelsByCostTier filters correctly", () => {
    const free = modelsByCostTier("free");
    expect(free.length).toBeGreaterThan(0);
    expect(free.every((m) => m.costTier === "free")).toBe(true);

    const paid = modelsByCostTier("paid");
    expect(paid.every((m) => m.costTier === "paid")).toBe(true);
  });

  test("every free-tier OpenRouter entry's id carries the :free suffix, matching OpenRouterBrain's own hard guard", () => {
    const openrouterModels = modelsForProvider("openrouter");
    for (const entry of openrouterModels) {
      if (entry.costTier === "free") {
        expect(entry.id.endsWith(":free")).toBe(true);
      }
    }
  });
});
