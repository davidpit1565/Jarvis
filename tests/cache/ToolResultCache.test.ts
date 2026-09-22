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

  describe("getSemantic (opt-in, additive Semantic Result Cache)", () => {
    test("returns undefined when nothing was cached with an embedding", () => {
      const cache = new ToolResultCache(60_000);
      cache.set("SEARCH_NEWS", { query: "AI news today" }, { success: true, data: "x" }); // no embedding
      expect(cache.getSemantic("SEARCH_NEWS", [1, 0])).toBeUndefined();
    });

    test("a semantically similar query (different exact input) hits the cache", () => {
      const cache = new ToolResultCache(60_000);
      cache.set("SEARCH_NEWS", { query: "AI news today" }, { success: true, data: "headlines" }, [1, 0, 0]);

      // "today's AI news" — different exact string, near-identical embedding
      const hit = cache.getSemantic("SEARCH_NEWS", [0.99, 0.01, 0]);
      expect(hit).toEqual({ success: true, data: "headlines" });
    });

    test("a dissimilar query does not hit the cache", () => {
      const cache = new ToolResultCache(60_000);
      cache.set("SEARCH_NEWS", { query: "AI news today" }, { success: true, data: "headlines" }, [1, 0, 0]);

      // "AI stocks today" — a genuinely different question, orthogonal embedding
      expect(cache.getSemantic("SEARCH_NEWS", [0, 1, 0])).toBeUndefined();
    });

    test("a tool that never stored an embedding never gets a semantic match, regardless of similarity", () => {
      const cache = new ToolResultCache(60_000);
      // GET_WEATHER never opted into semanticCacheable, so its entries
      // never carry an embedding, even if the cache instance is also
      // caching a different, semantic-cacheable tool.
      cache.set("GET_WEATHER", { city: "Tel Aviv" }, { success: true, data: { tempC: 25 } }); // no embedding
      cache.set("SEARCH_NEWS", { query: "AI news today" }, { success: true, data: "headlines" }, [1, 0, 0]);

      expect(cache.getSemantic("GET_WEATHER", [1, 0, 0])).toBeUndefined();
    });

    test("never matches across different tools, even with identical embeddings", () => {
      const cache = new ToolResultCache(60_000);
      cache.set("SEARCH_NEWS", { query: "AI news today" }, { success: true, data: "news" }, [1, 0]);
      expect(cache.getSemantic("SEARCH_WEB", [1, 0])).toBeUndefined();
    });

    test("an expired entry is never a semantic hit", async () => {
      const cache = new ToolResultCache(10);
      cache.set("SEARCH_NEWS", { query: "AI news today" }, { success: true, data: "news" }, [1, 0]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(cache.getSemantic("SEARCH_NEWS", [1, 0])).toBeUndefined();
    });

    test("TTL 0 disables semantic caching too", () => {
      const cache = new ToolResultCache(0);
      cache.set("SEARCH_NEWS", { query: "AI news today" }, { success: true, data: "news" }, [1, 0]);
      expect(cache.getSemantic("SEARCH_NEWS", [1, 0])).toBeUndefined();
    });

    test("a semantic hit counts toward the same hit/miss stats as an exact hit", () => {
      const cache = new ToolResultCache(60_000);
      cache.set("SEARCH_NEWS", { query: "AI news today" }, { success: true, data: "news" }, [1, 0]);
      cache.getSemantic("SEARCH_NEWS", [0.99, 0.01]);
      expect(cache.getStats().hits).toBe(1);
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
