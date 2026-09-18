/**
 * A small in-memory sliding-window rate limiter — every attempt counts
 * against the limit, not just failures, so it defends a brute-forceable
 * secret (a pairing code, an admin token) the same way whether the guesses
 * are right or wrong. Per-process, in-memory state is a deliberate choice
 * for a single-instance personal assistant: it resets on restart, which is
 * an acceptable tradeoff for the simplicity of not needing a shared store.
 */
// Every key that ever calls attempt() (a client IP, a tool+user pair)
// would otherwise stay in `hits` forever, since a key whose attempts have
// all aged out of the window is left behind as an empty array rather than
// removed. On a long-running, internet-facing process this grows without
// bound. A periodic sweep — rather than trying to clean up on every single
// call, which would still miss keys that stop being touched entirely —
// bounds that growth to roughly one sweep interval's worth of stale keys.
const SWEEP_INTERVAL_ATTEMPTS = 500;

export class RateLimiter {
  private hits: Map<string, number[]> = new Map();
  private attemptsSinceSweep = 0;

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
      this.maybeSweep(now);
      return false;
    }

    recent.push(now);
    this.hits.set(key, recent);
    this.maybeSweep(now);
    return true;
  }

  /** Drops any key whose every recorded attempt has aged out of the window, bounding long-term memory growth. */
  private maybeSweep(now: number): void {
    this.attemptsSinceSweep += 1;
    if (this.attemptsSinceSweep < SWEEP_INTERVAL_ATTEMPTS) return;
    this.attemptsSinceSweep = 0;

    for (const [key, timestamps] of this.hits) {
      const stillRecent = timestamps.some((timestamp) => now - timestamp < this.windowMs);
      if (!stillRecent) this.hits.delete(key);
    }
  }
}
