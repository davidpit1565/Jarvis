export interface ActivityEntry {
  timestamp: string;
  message: string;
}

const MAX_ENTRIES = 30;

/**
 * A small in-memory ring buffer of recent, human-readable activity —
 * feeds the dashboard's "Activity" panel. Not a durable audit log (it
 * resets on restart); for that, the eventBus itself remains the source
 * of truth.
 */
export class ActivityLog {
  private entries: ActivityEntry[] = [];

  record(message: string): void {
    this.entries.unshift({ timestamp: new Date().toISOString(), message });
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.length = MAX_ENTRIES;
    }
  }

  list(): ActivityEntry[] {
    return [...this.entries];
  }
}
