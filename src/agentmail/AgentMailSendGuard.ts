/**
 * A simple per-day usage cap on SEND_AGENT_EMAIL — same shape and same
 * reasoning as `TwilioCostGuard` (`src/communication/phone/TwilioCostGuard.ts`):
 * AgentMail bills (or otherwise rate-limits) per send, and nothing
 * previously stopped a misbehaving automation rule or a runaway agent
 * loop from sending an unbounded number of real emails from JARVIS's own
 * identity in a single day.
 *
 * Deliberately its own small class rather than reusing `TwilioCostGuard`
 * directly — same spirit (an in-memory per-day counter keyed by a
 * caller-supplied date string), but a distinct type so this integration's
 * cap is never accidentally shared with Twilio's outbound-call cap.
 *
 * Callers pass in today's date key (`formatDateKey(now, config.timezone)`,
 * the same helper the wake-up call scheduler already uses) rather than
 * this class computing "now" itself — keeps it a pure, trivially-testable
 * counter with no clock/timezone logic of its own.
 */
export class AgentMailSendGuard {
  private readonly countsByDay: Map<string, number> = new Map();

  constructor(private readonly maxPerDay: number) {}

  /**
   * If today's count is under the cap, records one more use and returns
   * true. If the cap's already been hit today, returns false and records
   * nothing.
   */
  tryConsume(todayKey: string): boolean {
    const count = this.countsByDay.get(todayKey) ?? 0;
    if (count >= this.maxPerDay) return false;
    this.countsByDay.set(todayKey, count + 1);
    this.pruneOldDays(todayKey);
    return true;
  }

  /** How many more sends are allowed today, without consuming one. */
  remaining(todayKey: string): number {
    return Math.max(0, this.maxPerDay - (this.countsByDay.get(todayKey) ?? 0));
  }

  // A long-running process would otherwise grow this map by one entry per
  // calendar day forever; nothing needs more than the current day's count.
  private pruneOldDays(todayKey: string): void {
    if (this.countsByDay.size <= 1) return;
    for (const key of this.countsByDay.keys()) {
      if (key !== todayKey) this.countsByDay.delete(key);
    }
  }
}
