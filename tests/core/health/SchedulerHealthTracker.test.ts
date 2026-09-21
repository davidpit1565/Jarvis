import { describe, test, expect } from "bun:test";
import { SchedulerHealthTracker } from "@/core/health/SchedulerHealthTracker";

describe("SchedulerHealthTracker", () => {
  test("snapshot is empty before any tick", () => {
    const tracker = new SchedulerHealthTracker();
    expect(tracker.snapshot()).toEqual([]);
  });

  test("tick records a scheduler with a lastTickAt and zero-ish age", () => {
    const tracker = new SchedulerHealthTracker();
    const before = Date.now();
    tracker.tick("wakeUpCalls");
    const snapshot = tracker.snapshot();

    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]!.name).toBe("wakeUpCalls");
    expect(new Date(snapshot[0]!.lastTickAt).getTime()).toBeGreaterThanOrEqual(before);
    expect(snapshot[0]!.ageMs).toBeGreaterThanOrEqual(0);
  });

  test("tracks multiple named schedulers independently", () => {
    const tracker = new SchedulerHealthTracker();
    tracker.tick("wakeUpCalls");
    tracker.tick("automationRules");
    tracker.tick("reminderNotifications");

    const names = tracker.snapshot().map((s) => s.name);
    expect(names.sort()).toEqual(["automationRules", "reminderNotifications", "wakeUpCalls"]);
  });

  test("a later tick for the same scheduler overwrites its lastTickAt", () => {
    const tracker = new SchedulerHealthTracker();
    tracker.tick("alarms");
    const firstSnapshot = tracker.snapshot(Date.now() + 10_000);
    expect(firstSnapshot[0]!.ageMs).toBeGreaterThanOrEqual(10_000);

    tracker.tick("alarms");
    const secondSnapshot = tracker.snapshot(Date.now());
    expect(secondSnapshot).toHaveLength(1);
    expect(secondSnapshot[0]!.ageMs).toBeLessThan(1_000);
  });

  test("age is computed against a supplied `now`, useful for deterministic tests", () => {
    const tracker = new SchedulerHealthTracker();
    tracker.tick("checkin");
    const snapshot = tracker.snapshot(Date.now() + 5_000);
    expect(snapshot[0]!.ageMs).toBeGreaterThanOrEqual(5_000);
  });
});
