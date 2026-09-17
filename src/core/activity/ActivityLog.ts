/** "thinking"/"speaking" drive the dashboard's live ticker and hologram glow; "info" is everything else (device/tool events). */
export type ActivityKind = "info" | "thinking" | "speaking";

export interface ActivityEntry {
  timestamp: string;
  message: string;
  kind: ActivityKind;
}

const MAX_ENTRIES = 30;

/**
 * A small in-memory ring buffer of recent, human-readable activity —
 * feeds the dashboard's "Activity" panel and live ticker. Not a durable
 * audit log (it resets on restart); for that, the eventBus itself
 * remains the source of truth.
 */
export class ActivityLog {
  private entries: ActivityEntry[] = [];

  record(message: string, kind: ActivityKind = "info"): void {
    this.entries.unshift({ timestamp: new Date().toISOString(), message, kind });
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.length = MAX_ENTRIES;
    }
  }

  list(): ActivityEntry[] {
    return [...this.entries];
  }
}
