import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { GoalStore } from "@/agent/GoalStore";
import { AgentTaskStore } from "@/agent/AgentTaskStore";
import { goalProgressNote } from "@/agent/goalProgressNote";

describe("goalProgressNote", () => {
  let goalStore: GoalStore;
  let taskStore: AgentTaskStore;

  beforeEach(() => {
    goalStore = new GoalStore(":memory:");
    taskStore = new AgentTaskStore(":memory:");
  });

  afterEach(() => {
    goalStore.close();
    taskStore.close();
  });

  test("returns undefined when the user has no active goals", () => {
    expect(goalProgressNote(goalStore, taskStore, "u1")).toBeUndefined();
  });

  test("omits a completed goal", () => {
    const goal = goalStore.create({ userId: "u1", description: "Done thing" });
    goalStore.complete(goal.id);
    expect(goalProgressNote(goalStore, taskStore, "u1")).toBeUndefined();
  });

  test("surfaces an active goal with its progress and next step", () => {
    const goal = goalStore.create({ userId: "u1", description: "Launch my app" });
    const t1 = taskStore.create({ userId: "u1", goal: "Write the landing page", goalId: goal.id });
    taskStore.create({ userId: "u1", goal: "Submit to App Store", goalId: goal.id });
    taskStore.setState(t1.id, "PLANNING");
    taskStore.setState(t1.id, "EXECUTING");
    taskStore.setState(t1.id, "COMPLETED");

    const note = goalProgressNote(goalStore, taskStore, "u1");
    expect(note).toContain("Launch my app");
    expect(note).toContain("1/2 steps done");
    expect(note).toContain("Submit to App Store");
  });

  test("never surfaces another user's goal", () => {
    goalStore.create({ userId: "other-user", description: "Not yours" });
    expect(goalProgressNote(goalStore, taskStore, "u1")).toBeUndefined();
  });

  test("caps the number of goals listed so the note can't grow unboundedly", () => {
    for (let i = 0; i < 25; i++) {
      goalStore.create({ userId: "u1", description: `Goal number ${i}` });
    }

    const note = goalProgressNote(goalStore, taskStore, "u1")!;
    expect(note).toBeDefined();
    const goalLines = note.split("\n").filter((line) => line.startsWith("- "));
    expect(goalLines.length).toBeLessThan(25);
    // Still reports the true total and says more exist, rather than
    // silently truncating.
    expect(note).toContain("25 active goal(s)");
    expect(note).toMatch(/more not shown/);
  });
});
