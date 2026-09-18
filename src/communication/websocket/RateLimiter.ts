/**
 * A small in-memory sliding-window rate limiter — every attempt counts
 * against the limit, not just failures, so it defends a brute-forceable
 * secret (a pairing code, an admin token) the same way whether the guesses
 * are right or wrong. Per-process, in-memory state is a deliberate choice
 * for a single-instance personal assistant: it resets on restart, which is
 * an acceptable tradeoff for the simplicity of not needing a shared store.
 */
export class RateLimiter {
  private hits: Map<string, number[]> = new Map();

  constructor(
    private readonly maxAttempts: number,
    private readonly windowMs: number
  ) {}

  /** Records one attempt for `key` and returns whether it's allowed under the limit. */
  attempt(key: string): boolean {
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((timestamp) => now - timestamp < this.windowMs);

    if (recent.length >= this.maxAttempts) {
      this.hits.set(key, recent);
      return false;
    }

    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}
