const DEFAULT_WINDOW_MS = 5 * 60_000; // 5 minutes

/**
 * Generalizes ReminderStore's own `notifiedAt` dedup pattern (a
 * persisted "already sent this one" flag) to proactive channels that
 * don't have their own per-item persisted flag — automation-rule result
 * pushes, and the stale-commitment follow-up nudge. Reminders themselves
 * keep using notifiedAt directly (see ReminderStore/dueRemindersNote);
 * this is deliberately NOT a replacement for that, just the same idea
 * made reusable for everything else.
 *
 * In-memory and per-process by design: this only needs to catch a
 * scheduler double-tick or an in-flight retry racing the next tick
 * within the same short window, not survive a restart — a restart-
 * spanning duplicate is already what each source's own persisted state
 * (lastTriggeredDate, notifiedAt, status) prevents.
 */
export class NotificationDedup {
  private lastSentAtMs = new Map<string, number>();

  constructor(private readonly windowMs: number = DEFAULT_WINDOW_MS) {}

  /**
   * True (and records the send) the first time `key` is seen, or once
   * `windowMs` has passed since the last time it was sent. False — and
   * no record made — if it was already sent within the window, meaning
   * the caller should suppress this send as a duplicate.
   */
  shouldSend(key: string, nowMs: number = Date.now()): boolean {
    const last = this.lastSentAtMs.get(key);
    if (last !== undefined && nowMs - last < this.windowMs) {
      return false;
    }
    this.lastSentAtMs.set(key, nowMs);
    this.prune(nowMs);
    return true;
  }

  /** Bounds memory growth — drops entries old enough they can never suppress a future send anyway. */
  private prune(nowMs: number): void {
    for (const [key, sentAtMs] of this.lastSentAtMs) {
      if (nowMs - sentAtMs >= this.windowMs) {
        this.lastSentAtMs.delete(key);
      }
    }
  }
}
