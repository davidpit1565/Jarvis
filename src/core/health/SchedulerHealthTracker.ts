export interface SchedulerTickInfo {
  name: string;
  lastTickAt: string;
  ageMs: number;
}

/**
 * Tracks "is this `setInterval` loop actually still ticking" for each of
 * JARVIS's background schedulers (wake-up calls, alarms, weekly digest,
 * check-in, morning briefing, automation rules, reminder notifications)
 * — see JARVIS_ROADMAP_AUDIT.md #176. Each scheduler calls `.tick(name)`
 * once at the top of its own interval callback; `GET /status` surfaces
 * `snapshot()` so a scheduler that silently stopped firing (an unhandled
 * synchronous throw before the tick call, a bug that broke the interval,
 * a feature that was never enabled) is visible instead of invisible —
 * before this, a stalled scheduler had no observable symptom until
 * someone happened to notice a specific automation never firing.
 *
 * Deliberately in-memory only: this answers "is the current process
 * still alive and looping," not "did every scheduled event fire since
 * the last restart" (that's what each feature's own persisted
 * `lastTriggeredDate`/`notifiedAt` fields are for).
 */
export class SchedulerHealthTracker {
  private readonly lastTick = new Map<string, number>();

  /** Records that the named scheduler just ran a tick, right now. */
  tick(name: string): void {
    this.lastTick.set(name, Date.now());
  }

  /** Every scheduler that has ticked at least once since this tracker was created. */
  snapshot(now: number = Date.now()): SchedulerTickInfo[] {
    return Array.from(this.lastTick.entries()).map(([name, lastTickAt]) => ({
      name,
      lastTickAt: new Date(lastTickAt).toISOString(),
      ageMs: now - lastTickAt,
    }));
  }
}
