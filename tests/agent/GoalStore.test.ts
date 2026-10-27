import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { GoalStore, GoalNotFoundError } from "@/agent/GoalStore";

describe("GoalStore", () => {
  let store: GoalStore;

  beforeEach(() => {
    store = new GoalStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("create() generates an id and defaults to active", () => {
    const goal = store.create({ userId: "u1", description: "Launch my app" });
    expect(goal.id).toBeTruthy();
    expect(goal.userId).toBe("u1");
    expect(goal.description).toBe("Launch my app");
    expect(goal.status).toBe("active");
    expect(goal.closedAt).toBeNull();
  });

  test("createWithId() uses the exact id given", () => {
    const goal = store.createWithId("my-goal-id", { userId: "u1", description: "Launch my app" });
    expect(goal.id).toBe("my-goal-id");
    expect(store.get("my-goal-id")?.id).toBe("my-goal-id");
  });

  test("get() returns null for an unknown id", () => {
    expect(store.get("missing")).toBeNull();
  });

  test("requireOrThrow() throws GoalNotFoundError for an unknown id", () => {
    expect(() => store.requireOrThrow("missing")).toThrow(GoalNotFoundError);
  });

  test("list() returns only the given user's goals, newest first", () => {
    store.create({ userId: "u1", description: "First" });
    store.create({ userId: "u2", description: "Other user's goal" });
    const second = store.create({ userId: "u1", description: "Second" });

    const goals = store.list("u1");
    expect(goals).toHaveLength(2);
    expect(goals[0]?.id).toBe(second.id);
  });

  test("list() filters by status", () => {
    const a = store.create({ userId: "u1", description: "A" });
    store.create({ userId: "u1", description: "B" });
    store.complete(a.id);

    expect(store.list("u1", "completed")).toHaveLength(1);
    expect(store.list("u1", "active")).toHaveLength(1);
  });

  test("complete() transitions an active goal to completed and stamps closedAt", () => {
    const goal = store.create({ userId: "u1", description: "A" });
    const updated = store.complete(goal.id);
    expect(updated.status).toBe("completed");
    expect(updated.closedAt).not.toBeNull();
  });

  test("abandon() transitions an active goal to abandoned", () => {
    const goal = store.create({ userId: "u1", description: "A" });
    const updated = store.abandon(goal.id);
    expect(updated.status).toBe("abandoned");
    expect(updated.closedAt).not.toBeNull();
  });

  test("complete() on an already-closed goal is a harmless no-op, not a double-close", () => {
    const goal = store.create({ userId: "u1", description: "A" });
    store.abandon(goal.id);
    const result = store.complete(goal.id);
    // Still abandoned — a terminal status never flips to a different terminal status.
    expect(result.status).toBe("abandoned");
  });

  test("complete() throws for an unknown id", () => {
    expect(() => store.complete("missing")).toThrow(GoalNotFoundError);
  });
});
