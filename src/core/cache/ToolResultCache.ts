import type { ToolResult } from "@/types/tools";
import { cosineSimilarity } from "@/core/embeddings/similarity";

interface CacheEntry {
  result: ToolResult;
  expiresAt: number;
  toolName: string;
  /** Only set when this entry was cached with an embedding — see `setSemantic`. */
  embedding?: number[];
}

/**
 * Semantic Result Cache: the similarity threshold above which two DIFFERENT
 * inputs to the SAME tool are considered "close enough" to serve the same
 * cached answer (JARVIS_ROADMAP_AUDIT.md #60, "Semantic Cache" — previously
 * skipped for lack of a free embeddings source; OllamaEmbeddingsClient is
 * that source now).
 *
 * Chosen deliberately HIGH (0.92 on cosine similarity's [-1, 1] scale) —
 * much higher than MemoryStore's semantic *search* threshold (0.5) — for
 * the opposite reason: a cache hit is served silently, with no human in
 * the loop to notice a near-miss the way they would skimming a memory
 * search's results list. Serving a stale/wrong answer because two
 * genuinely different questions ("AI news today" vs. "AI stocks today")
 * were judged "similar enough" is a real correctness bug, not a minor
 * inconvenience — so this only matches true near-paraphrases (word order,
 * tense, filler words: "AI news today" vs. "today's AI news"), which is
 * also all a per-tool `semanticCacheable` opt-in is meant to cover in the
 * first place (see `Tool.semanticCacheable`'s own doc comment for which
 * tools that is and isn't appropriate for).
 */
export const SEMANTIC_CACHE_SIMILARITY_THRESHOLD = 0.92;

/**
 * A small in-memory, TTL-based cache of tool-call results, keyed on the
 * tool name plus its exact input — so a repeated, identical READ-tool
 * call (e.g. GET_WEATHER for the same city twice within a minute) is
 * served from memory instead of re-running the tool (a real network
 * call, a rate-limited API, sometimes a billed one). Deliberately
 * simple: no external dependency, no persistence, no LRU eviction beyond
 * lazy expiry-on-read plus an unbounded-but-small `Map` that a periodic
 * `sweep()` keeps from growing forever — this is a request-shaping
 * optimization, not a durable store, and it resets on restart same as
 * `AIRouter`'s own in-memory provider stats.
 *
 * Callers (Orchestrator) are responsible for only ever caching tools
 * that are actually safe to cache — idempotent, side-effect-free READ
 * calls — this class has no opinion on permission levels and will
 * happily cache anything it's given.
 */
export class ToolResultCache {
  private readonly store = new Map<string, CacheEntry>();
  /**
   * Aggregate hit/miss counters (JARVIS_ROADMAP_AUDIT.md batch 3 —
   * "measure, don't assume" applied to the tool-result cache too). Before
   * this, the only signal a cache hit produced was the `tool.cacheHit`
   * EventBus event Orchestrator emits — real, but ephemeral: nothing
   * persisted it, so there was no way to answer "what's this cache's hit
   * rate" after the fact. In-memory only, same lifetime as `store` itself
   * (resets on restart) — this is operational telemetry for a status
   * endpoint, not a durable record, same reasoning as `AIRouter`'s own
   * rolling provider stats.
   */
  private hits = 0;
  private misses = 0;

  /**
   * @param ttlMs How long an entry stays valid after being set. 0 (or
   *   negative) disables caching entirely — `get` always misses and
   *   `set` is a no-op, so a caller can wire this in unconditionally and
   *   let config (`JARVIS_TOOL_RESULT_CACHE_TTL_MS=0`) turn it off.
   */
  constructor(private readonly ttlMs: number) {}

  /** Deterministic cache key for a tool call: the tool name plus a stable JSON encoding of its input. */
  static keyFor(toolName: string, input: Record<string, unknown>): string {
    return `${toolName}:${stableStringify(input)}`;
  }

  get(toolName: string, input: Record<string, unknown>): ToolResult | undefined {
    if (this.ttlMs <= 0) return undefined;
    const key = ToolResultCache.keyFor(toolName, input);
    const entry = this.store.get(key);
    if (!entry || Date.now() >= entry.expiresAt) {
      if (entry) this.store.delete(key);
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    return entry.result;
  }

  /** Aggregate hit/miss counts and hit rate since this instance was created (or last `resetStats()`). `hitRate` is 0 when nothing has been looked up yet, not NaN. */
  getStats(): { hits: number; misses: number; hitRate: number } {
    const total = this.hits + this.misses;
    return { hits: this.hits, misses: this.misses, hitRate: total > 0 ? this.hits / total : 0 };
  }

  /** Resets the hit/miss counters to 0. Exposed for tests/diagnostics — never required for correctness. */
  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * @param embedding Semantic Result Cache only (see
   *   `SEMANTIC_CACHE_SIMILARITY_THRESHOLD`'s own doc comment): an
   *   embedding of this call's input, stored alongside the exact-match
   *   entry so a LATER, differently-worded call to the same tool can find
   *   it via `getSemantic`. Omitted (the default) means this entry is
   *   exact-match only, exactly as before this feature existed — the
   *   caller (Orchestrator) only ever passes one when the tool opted in
   *   via `Tool.semanticCacheable` AND embeddings are configured.
   */
  set(toolName: string, input: Record<string, unknown>, result: ToolResult, embedding?: number[]): void {
    if (this.ttlMs <= 0) return;
    // Never cache a failed call — a transient error (rate limit, network
    // blip) should never be replayed as if it were a real, current
    // answer for the rest of the TTL window.
    if (!result.success) return;
    const key = ToolResultCache.keyFor(toolName, input);
    this.store.set(key, { result, expiresAt: Date.now() + this.ttlMs, toolName, embedding });
  }

  /**
   * Semantic Result Cache (additive, opt-in — see
   * `SEMANTIC_CACHE_SIMILARITY_THRESHOLD`'s own doc comment). Looks for a
   * NON-expired, previously-cached entry for the SAME `toolName` (never
   * across different tools) whose stored embedding is at or above the
   * similarity threshold against `queryEmbedding`, and returns its result.
   * Only ever consults entries that were stored WITH an embedding (via
   * `set`'s optional 4th argument) — a tool that never opted in via
   * `Tool.semanticCacheable` never has any such entries, so this always
   * returns undefined for it regardless of how similar an input might be.
   *
   * A cache-instance-wide linear scan, same reasoning as
   * `MemoryStore.searchSemantic`'s own doc comment: this is a small,
   * bounded, in-memory cache (see the class doc comment — no LRU, no
   * external dependency), not a workload that needs real indexing.
   *
   * Ties into the same `getStats()` hit counter as `get()` — a semantic
   * hit is still a cache hit. Never increments the miss counter itself
   * (the caller's preceding `get()` call already counted the exact-match
   * miss that led here).
   */
  getSemantic(toolName: string, queryEmbedding: number[]): ToolResult | undefined {
    if (this.ttlMs <= 0) return undefined;
    const now = Date.now();
    let best: { result: ToolResult; similarity: number } | undefined;

    for (const entry of this.store.values()) {
      if (entry.toolName !== toolName) continue;
      if (!entry.embedding) continue;
      if (now >= entry.expiresAt) continue;
      if (entry.embedding.length !== queryEmbedding.length) continue;

      const similarity = cosineSimilarity(queryEmbedding, entry.embedding);
      if (similarity >= SEMANTIC_CACHE_SIMILARITY_THRESHOLD && (!best || similarity > best.similarity)) {
        best = { result: entry.result, similarity };
      }
    }

    if (!best) return undefined;
    this.hits += 1;
    return best.result;
  }

  /** Drops every expired entry. Not required for correctness (get() already checks expiry) — just keeps memory bounded for a long-running process. */
  sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now >= entry.expiresAt) this.store.delete(key);
    }
  }

  /** Number of entries currently stored, expired or not — exposed for tests/diagnostics. */
  get size(): number {
    return this.store.size;
  }
}

/**
 * A JSON.stringify with object keys sorted, so two calls with the same
 * input but different key insertion order (e.g. `{a:1,b:2}` vs.
 * `{b:2,a:1}`) hit the same cache key. Arrays keep their order (order is
 * meaningful there); only plain-object key order is normalized.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
