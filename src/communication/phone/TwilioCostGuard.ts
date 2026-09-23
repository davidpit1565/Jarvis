/**
 * A simple per-day usage cap for a paid Twilio action (currently: placing
 * an outbound call). Twilio bills per call, and unlike every AI-provider
 * call — gated by `CostTracker`/`AIRouter`'s daily/monthly $ budget —
 * nothing previously stopped a misconfigured wake-up call rule (or several
 * of them) from placing an unbounded number of real, billed calls in a
 * day.
 *
 * Deliberately not `CostTracker` itself: `CostTracker` prices things in
 * USD from token usage, and Twilio's own per-call rate isn't tracked
 * anywhere in this codebase (it varies by destination and isn't something
 * JARVIS gets back from the API call). This counts *uses against a daily
 * limit*, not dollars — a small, purpose-fit guard rather than forcing an
 * unrelated pricing model onto a feature that doesn't have pricing data to
 * begin with.
 *
 * Callers pass in today's date key (same "YYYY-MM-DD in the configured
 * timezone" shape as `formatDateKey`/`WakeUpCallStore.markTriggered`, see
 * `src/wakeup/getDueWakeUpCalls.ts`) rather than this class computing
 * "now" itself — keeps it a pure, trivially-testable counter with no
 * clock/timezone logic of its own, matching how the wake-up call
 * scheduler already threads a single `todayDateStr` through everything
 * else it touches.
 */
export class TwilioCostGuard {
  private readonly countsByDay: Map<string, number> = new Map();

  constructor(private readonly maxPerDay: number) {}

  /**
   * If today's count is under the cap, records one more use and returns
   * true. If the cap's already been hit today, returns false and records
   * nothing — the caller decides what "blocked" means (skip the call,
   * notify the user, etc.), this only ever answers "is there room."
   */
  tryConsume(todayKey: string): boolean {
    const count = this.countsByDay.get(todayKey) ?? 0;
    if (count >= this.maxPerDay) return false;
    this.countsByDay.set(todayKey, count + 1);
    this.pruneOldDays(todayKey);
    return true;
  }

  /** How many more uses are allowed today, without consuming one. */
  remaining(todayKey: string): number {
    return Math.max(0, this.maxPerDay - (this.countsByDay.get(todayKey) ?? 0));
  }

  /**
   * Refunds one consumed use for `todayKey` — call this when a
   * `tryConsume()`-gated action actually failed (e.g. the Twilio API call
   * itself threw), so a run of transient failures doesn't burn through
   * the daily cap with zero real calls placed and then silently block
   * every legitimate call for the rest of the day. A no-op once today's
   * count is already 0.
   */
  release(todayKey: string): void {
    const count = this.countsByDay.get(todayKey) ?? 0;
    if (count > 0) this.countsByDay.set(todayKey, count - 1);
  }

  // A long-running process would otherwise grow this map by one entry per
  // calendar day forever; nothing needs more than the current day's count,
  // so every other day's entry is dropped as soon as a new day shows up.
  private pruneOldDays(todayKey: string): void {
    if (this.countsByDay.size <= 1) return;
    for (const key of this.countsByDay.keys()) {
      if (key !== todayKey) this.countsByDay.delete(key);
    }
  }
}
