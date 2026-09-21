import type { ToolResult } from "@/types/tools";

interface CacheEntry {
  result: ToolResult;
  expiresAt: number;
}

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
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.result;
  }

  set(toolName: string, input: Record<string, unknown>, result: ToolResult): void {
    if (this.ttlMs <= 0) return;
    // Never cache a failed call — a transient error (rate limit, network
    // blip) should never be replayed as if it were a real, current
    // answer for the rest of the TTL window.
    if (!result.success) return;
    const key = ToolResultCache.keyFor(toolName, input);
    this.store.set(key, { result, expiresAt: Date.now() + this.ttlMs });
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
