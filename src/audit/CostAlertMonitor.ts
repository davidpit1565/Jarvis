const STAGES = [0.75, 0.9, 1.0];

/**
 * Fires a callback once each time cumulative estimated cost crosses a
 * stage (75%, 90%, 100%) of a configured threshold — each stage fires
 * exactly once, not on every call past it, so a long-running process
 * doesn't spam a warning on every single brain response once it's over
 * budget. All-time, not a rolling window, matching TokenUsageStore's own
 * all-time totals.
 */
export class CostAlertMonitor {
  private readonly firedStages: Set<number> = new Set();

  constructor(
    private readonly thresholdUsd: number,
    private readonly onAlert: (stagePercent: number, costUsd: number, thresholdUsd: number) => void
  ) {}

  check(costUsd: number): void {
    for (const stage of STAGES) {
      if (this.firedStages.has(stage)) continue;
      if (costUsd >= this.thresholdUsd * stage) {
        this.firedStages.add(stage);
        this.onAlert(stage, costUsd, this.thresholdUsd);
      }
    }
  }
}
