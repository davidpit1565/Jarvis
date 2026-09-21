import { describe, test, expect } from "bun:test";
import { AgentTaskStore, AgentTaskNotFoundError } from "@/agent/AgentTaskStore";
import { InvalidAgentTaskTransitionError } from "@/agent/AgentTaskStateMachine";

describe("AgentTaskStore", () => {
  test("creates a task in PENDING with an empty plan", () => {
    const store = new AgentTaskStore(":memory:");
    const task = store.create({ userId: "user-1", goal: "send a test email" });

    expect(task.state).toBe("PENDING");
    expect(task.plan).toEqual([]);
    expect(task.currentStepIndex).toBe(0);
    expect(task.stepRetryCount).toBe(0);
    expect(task.recoveryCount).toBe(0);
    expect(task.totalStepsExecuted).toBe(0);
    expect(task.failureReason).toBeNull();
    expect(task.completedAt).toBeNull();
    store.close();
  });

  test("round-trips a task by id", () => {
    const store = new AgentTaskStore(":memory:");
    const task = store.create({ userId: "user-1", goal: "goal" });
    const fetched = store.get(task.id);
    expect(fetched).toEqual(task);
    store.close();
  });

  test("get returns null for an unknown id", () => {
    const store = new AgentTaskStore(":memory:");
    expect(store.get("missing")).toBeNull();
    store.close();
  });

  test("requireOrThrow throws AgentTaskNotFoundError for an unknown id", () => {
    const store = new AgentTaskStore(":memory:");
    expect(() => store.requireOrThrow("missing")).toThrow(AgentTaskNotFoundError);
    store.close();
  });

  test("setState applies a legal transition and stamps completedAt on terminal states", () => {
    const store = new AgentTaskStore(":memory:");
    const task = store.create({ userId: "user-1", goal: "goal" });

    const planning = store.setState(task.id, "PLANNING");
    expect(planning.state).toBe("PLANNING");
    expect(planning.completedAt).toBeNull();

    store.setState(task.id, "EXECUTING");
    const cancelled = store.setState(task.id, "CANCELLED");
    expect(cancelled.state).toBe("CANCELLED");
    expect(cancelled.completedAt).not.toBeNull();
    store.close();
  });

  test("setState rejects an illegal transition", () => {
    const store = new AgentTaskStore(":memory:");
    const task = store.create({ userId: "user-1", goal: "goal" });
    expect(() => store.setState(task.id, "COMPLETED")).toThrow(InvalidAgentTaskTransitionError);
    store.close();
  });

  test("setPlan installs plan steps and resets step/retry counters", () => {
    const store = new AgentTaskStore(":memory:");
    const task = store.create({ userId: "user-1", goal: "goal" });
    store.setState(task.id, "PLANNING");

    const withPlan = store.setPlan(task.id, [
      { toolName: "create_reminder", input: { text: "call mom" }, description: "create the reminder" },
      { toolName: "list_reminders", input: {}, description: "confirm it exists" },
    ]);

    expect(withPlan.plan).toHaveLength(2);
    expect(withPlan.plan[0]?.status).toBe("pending");
    expect(withPlan.plan[0]?.toolName).toBe("create_reminder");
    expect(withPlan.currentStepIndex).toBe(0);
    expect(withPlan.stepRetryCount).toBe(0);
    store.close();
  });

  test("recordStepResult marks a step succeeded/failed and increments totalStepsExecuted", () => {
    const store = new AgentTaskStore(":memory:");
    const task = store.create({ userId: "user-1", goal: "goal" });
    const withPlan = store.setPlan(task.id, [{ toolName: "t", input: {}, description: "d" }]);
    const stepId = withPlan.plan[0]!.id;

    const succeeded = store.recordStepResult(task.id, stepId, { success: true, data: { ok: true } });
    expect(succeeded.plan[0]?.status).toBe("succeeded");
    expect(succeeded.plan[0]?.lastResult).toEqual({ success: true, data: { ok: true } });
    expect(succeeded.totalStepsExecuted).toBe(1);

    const failed = store.recordStepResult(task.id, stepId, { success: false, error: "boom" });
    expect(failed.plan[0]?.status).toBe("failed");
    expect(failed.totalStepsExecuted).toBe(2);
    store.close();
  });

  test("markStepVerified sets verified/verification_failed with a reason", () => {
    const store = new AgentTaskStore(":memory:");
    const task = store.create({ userId: "user-1", goal: "goal" });
    const withPlan = store.setPlan(task.id, [{ toolName: "t", input: {}, description: "d" }]);
    const stepId = withPlan.plan[0]!.id;

    const verified = store.markStepVerified(task.id, stepId, true, "confirmed via list");
    expect(verified.plan[0]?.status).toBe("verified");
    expect(verified.plan[0]?.verificationReason).toBe("confirmed via list");

    const failedVerification = store.markStepVerified(task.id, stepId, false, "not found");
    expect(failedVerification.plan[0]?.status).toBe("verification_failed");
    store.close();
  });

  test("advanceStep increments currentStepIndex and resets stepRetryCount", () => {
    const store = new AgentTaskStore(":memory:");
    const task = store.create({ userId: "user-1", goal: "goal" });
    store.setPlan(task.id, [
      { toolName: "a", input: {}, description: "a" },
      { toolName: "b", input: {}, description: "b" },
    ]);
    store.incrementStepRetry(task.id);
    store.incrementStepRetry(task.id);

    const advanced = store.advanceStep(task.id);
    expect(advanced.currentStepIndex).toBe(1);
    expect(advanced.stepRetryCount).toBe(0);
    store.close();
  });

  test("incrementStepRetry and incrementRecoveryCount accumulate independently", () => {
    const store = new AgentTaskStore(":memory:");
    const task = store.create({ userId: "user-1", goal: "goal" });

    store.incrementStepRetry(task.id);
    const afterOneRetry = store.incrementStepRetry(task.id);
    expect(afterOneRetry.stepRetryCount).toBe(2);
    expect(afterOneRetry.recoveryCount).toBe(0);

    const afterRecovery = store.incrementRecoveryCount(task.id);
    expect(afterRecovery.recoveryCount).toBe(1);
    expect(afterRecovery.stepRetryCount).toBe(2);
    store.close();
  });

  test("setFailureReason records the reason without changing state", () => {
    const store = new AgentTaskStore(":memory:");
    const task = store.create({ userId: "user-1", goal: "goal" });
    const updated = store.setFailureReason(task.id, "planner returned empty plan");
    expect(updated.failureReason).toBe("planner returned empty plan");
    expect(updated.state).toBe("PENDING");
    store.close();
  });

  test("list returns tasks newest first, optionally filtered by userId", () => {
    const store = new AgentTaskStore(":memory:");
    const a = store.create({ userId: "user-1", goal: "goal a" });
    const b = store.create({ userId: "user-2", goal: "goal b" });
    const c = store.create({ userId: "user-1", goal: "goal c" });

    const all = store.list();
    expect(all.map((t) => t.id)).toEqual([c.id, b.id, a.id]);

    const user1Only = store.list("user-1");
    expect(user1Only.map((t) => t.id)).toEqual([c.id, a.id]);
    store.close();
  });

  test("mutating operations throw AgentTaskNotFoundError for an unknown task id", () => {
    const store = new AgentTaskStore(":memory:");
    expect(() => store.setPlan("missing", [])).toThrow(AgentTaskNotFoundError);
    expect(() => store.recordStepResult("missing", "step", { success: true })).toThrow(AgentTaskNotFoundError);
    expect(() => store.advanceStep("missing")).toThrow(AgentTaskNotFoundError);
    store.close();
  });

  test("survives a restart: a fresh AgentTaskStore against the same file sees the persisted task", () => {
    const path = `${import.meta.dir}/.tmp-agent-task-store-test.sqlite`;
    try {
      const store1 = new AgentTaskStore(path);
      const task = store1.create({ userId: "user-1", goal: "durable goal" });
      store1.setState(task.id, "PLANNING");
      store1.close();

      const store2 = new AgentTaskStore(path);
      const reloaded = store2.get(task.id);
      expect(reloaded?.goal).toBe("durable goal");
      expect(reloaded?.state).toBe("PLANNING");
      store2.close();
    } finally {
      try {
        require("node:fs").rmSync(path, { force: true });
        require("node:fs").rmSync(`${path}-wal`, { force: true });
        require("node:fs").rmSync(`${path}-shm`, { force: true });
      } catch {
        // best effort cleanup
      }
    }
  });
});
