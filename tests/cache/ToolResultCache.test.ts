import { describe, test, expect } from "bun:test";
import { ToolResultCache } from "@/core/cache/ToolResultCache";

describe("ToolResultCache", () => {
  test("a miss returns undefined", () => {
    const cache = new ToolResultCache(60_000);
    expect(cache.get("GET_WEATHER", { city: "Tel Aviv" })).toBeUndefined();
  });

  test("set then get returns the cached result for an identical call", () => {
    const cache = new ToolResultCache(60_000);
    const result = { success: true, data: { tempC: 25 } };
    cache.set("GET_WEATHER", { city: "Tel Aviv" }, result);
    expect(cache.get("GET_WEATHER", { city: "Tel Aviv" })).toEqual(result);
  });

  test("different input is a cache miss", () => {
    const cache = new ToolResultCache(60_000);
    cache.set("GET_WEATHER", { city: "Tel Aviv" }, { success: true, data: {} });
    expect(cache.get("GET_WEATHER", { city: "Jerusalem" })).toBeUndefined();
  });

  test("different tool name (same input) is a cache miss", () => {
    const cache = new ToolResultCache(60_000);
    cache.set("GET_WEATHER", { city: "Tel Aviv" }, { success: true, data: {} });
    expect(cache.get("GET_NEWS", { city: "Tel Aviv" })).toBeUndefined();
  });

  test("input key order doesn't matter", () => {
    const cache = new ToolResultCache(60_000);
    cache.set("SEARCH", { a: 1, b: 2 }, { success: true, data: "x" });
    expect(cache.get("SEARCH", { b: 2, a: 1 })).toEqual({ success: true, data: "x" });
  });

  test("entries expire after the TTL", async () => {
    const cache = new ToolResultCache(10);
    cache.set("GET_WEATHER", { city: "Tel Aviv" }, { success: true, data: {} });
    expect(cache.get("GET_WEATHER", { city: "Tel Aviv" })).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cache.get("GET_WEATHER", { city: "Tel Aviv" })).toBeUndefined();
  });

  test("TTL 0 disables caching entirely", () => {
    const cache = new ToolResultCache(0);
    cache.set("GET_WEATHER", { city: "Tel Aviv" }, { success: true, data: {} });
    expect(cache.get("GET_WEATHER", { city: "Tel Aviv" })).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  test("a failed result is never cached", () => {
    const cache = new ToolResultCache(60_000);
    cache.set("GET_WEATHER", { city: "Tel Aviv" }, { success: false, error: "rate limited" });
    expect(cache.get("GET_WEATHER", { city: "Tel Aviv" })).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  describe("getStats (aggregate hit/miss counters)", () => {
    test("starts at 0/0 with a 0 hit rate", () => {
      const cache = new ToolResultCache(60_000);
      expect(cache.getStats()).toEqual({ hits: 0, misses: 0, hitRate: 0 });
    });

    test("counts a miss then a hit correctly, with an accurate hit rate", () => {
      const cache = new ToolResultCache(60_000);
      cache.get("GET_WEATHER", { city: "Tel Aviv" }); // miss
      cache.set("GET_WEATHER", { city: "Tel Aviv" }, { success: true, data: {} });
      cache.get("GET_WEATHER", { city: "Tel Aviv" }); // hit
      cache.get("GET_WEATHER", { city: "Tel Aviv" }); // hit

      const stats = cache.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBeCloseTo(2 / 3, 5);
    });

    test("an expired entry counts as a miss, not a hit", async () => {
      const cache = new ToolResultCache(10);
      cache.set("GET_WEATHER", { city: "Tel Aviv" }, { success: true, data: {} });
      await new Promise((resolve) => setTimeout(resolve, 20));
      cache.get("GET_WEATHER", { city: "Tel Aviv" });
      expect(cache.getStats()).toEqual({ hits: 0, misses: 1, hitRate: 0 });
    });

    test("resetStats clears the counters back to 0", () => {
      const cache = new ToolResultCache(60_000);
      cache.set("A", {}, { success: true, data: 1 });
      cache.get("A", {});
      cache.resetStats();
      expect(cache.getStats()).toEqual({ hits: 0, misses: 0, hitRate: 0 });
    });
  });

  test("sweep removes only expired entries", async () => {
    const cache = new ToolResultCache(10);
    cache.set("A", {}, { success: true, data: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const fresh = new ToolResultCache(60_000);
    // Use a second cache with a long TTL to prove sweep() is scoped to
    // the instance it's called on, not global state.
    fresh.set("B", {}, { success: true, data: 2 });

    cache.sweep();
    expect(cache.size).toBe(0);
    expect(fresh.size).toBe(1);
  });
});
