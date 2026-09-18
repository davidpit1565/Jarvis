import { describe, test, expect } from "bun:test";
import { CostAlertMonitor } from "@/audit/CostAlertMonitor";

describe("CostAlertMonitor", () => {
  test("does not fire below the first stage (75%)", () => {
    const alerts: number[] = [];
    const monitor = new CostAlertMonitor(10, (stage) => alerts.push(stage));
    monitor.check(7);
    expect(alerts).toEqual([]);
  });

  test("fires the 75% stage once cost crosses it", () => {
    const alerts: number[] = [];
    const monitor = new CostAlertMonitor(10, (stage) => alerts.push(stage));
    monitor.check(7.5);
    expect(alerts).toEqual([0.75]);
  });

  test("fires each stage exactly once, in order, as cost climbs", () => {
    const alerts: number[] = [];
    const monitor = new CostAlertMonitor(10, (stage) => alerts.push(stage));
    monitor.check(7.5);
    monitor.check(9);
    monitor.check(10);
    expect(alerts).toEqual([0.75, 0.9, 1.0]);
  });

  test("a single call past every stage fires all of them at once, in order", () => {
    const alerts: number[] = [];
    const monitor = new CostAlertMonitor(10, (stage) => alerts.push(stage));
    monitor.check(50);
    expect(alerts).toEqual([0.75, 0.9, 1.0]);
  });

  test("does not re-fire a stage already crossed on subsequent calls", () => {
    const alerts: number[] = [];
    const monitor = new CostAlertMonitor(10, (stage) => alerts.push(stage));
    monitor.check(10);
    monitor.check(10);
    monitor.check(11);
    expect(alerts).toEqual([0.75, 0.9, 1.0]);
  });

  test("passes the actual cost and threshold to the callback", () => {
    let captured: { stage: number; cost: number; threshold: number } | undefined;
    const monitor = new CostAlertMonitor(20, (stage, cost, threshold) => {
      captured = { stage, cost, threshold };
    });
    monitor.check(15);
    expect(captured).toEqual({ stage: 0.75, cost: 15, threshold: 20 });
  });
});
