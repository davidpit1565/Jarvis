import { describe, test, expect } from "bun:test";
import { AgentCore } from "@/agent/AgentCore";
import { AgentTaskStore } from "@/agent/AgentTaskStore";
import type { AgentPlanRequest, AgentPlanner, AgentStepProposal, AgentVerificationRequest, AgentVerificationResult } from "@/agent/types";
import { Orchestrator } from "@/core/orchestrator/Orchestrator";
import { ConversationManager } from "@/core/conversation/ConversationManager";
import { EventBus } from "@/core/events/EventBus";
import { ToolRegistry } from "@/tools/registry/ToolRegistry";
import { PermissionService } from "@/permissions/PermissionService";
import { PermissionLevel } from "@/types/permissions";
import { ToolAuditLog } from "@/audit/ToolAuditLog";
import type { Brain, BrainRequest, BrainResponse } from "@/types/brain";
import type { LocalTool } from "@/types/tools";

/**
 * Covers the roadmap 26-34 additions to AgentCore/AgentTaskStore: Goal
 * Engine + Goal Progress, Dependencies/Waiting States, Resume After
 * Restart, the Persistent + Priority Agent Queue, the Background Agent
 * Worker tick, and the Agent Progress API. `AgentCore.test.ts` already
 * covers the pre-existing Plan/Execute/Verify/Recover loop in full — this
 * file only exercises what's new, on top of it.
 */

const unusedBrain: Brain = {
  async chat(_request: BrainRequest): Promise<BrainResponse> {
    throw new Error("Brain.chat should never be invoked in these tests");
  },
};

/** Always produces a single successful, non-verification-required step, or an empty plan if the goal contains "fail". */
class TrivialPlanner implements AgentPlanner {
  planCalls: string[] = [];

  async plan(request: AgentPlanRequest): Promise<AgentStepProposal[]> {
    this.planCalls.push(request.goal);
    if (request.goal.includes("fail")) return [];
    return [{ toolName: "noop_tool", input: {}, description: `do: ${request.goal}` }];
  }

  async verify(_request: AgentVerificationRequest): Promise<AgentVerificationResult> {
    return { verified: true, reason: "n/a" };
  }
}

function makeTool(overrides: Partial<LocalTool> & { name: string; execute: LocalTool["execute"] }): LocalTool {
  return {
    id: overrides.name.toUpperCase(),
    description: "test tool",
    inputSchema: { type: "object", properties: {} },
    requiredPermission: PermissionLevel.READ,
    target: "local",
    ...overrides,
  };
}

function setup(agentCoreOptions: ConstructorParameters<typeof AgentCore>[1] = {}) {
  const eventBus = new EventBus();
  const toolRegistry = new ToolRegistry();
  toolRegistry.registerTool(
    makeTool({ name: "noop_tool", requiredPermission: PermissionLevel.READ, execute: async () => ({ success: true, data: {} }) })
  );
  const permissionService = new PermissionService();
  const conversation = new ConversationManager(eventBus);

  const orchestrator = new Orchestrator({
    brain: unusedBrain,
    conversation,
    toolRegistry,
    permissionService,
    eventBus,
  });

  const taskStore = new AgentTaskStore(":memory:");
  const auditLog = new ToolAuditLog(":memory:");
  const planner = new TrivialPlanner();

  const agentCore = new AgentCore({ orchestrator, planner, toolRegistry, taskStore, auditLog, eventBus }, agentCoreOptions);

  return { agentCore, taskStore, auditLog, planner };
}

describe("AgentCore: Goal Engine + Goal Progress", () => {
  test("startGoal creates one task per sub-goal sharing a goalId, and getGoalProgress aggregates their outcomes", async () => {
    const { agentCore } = setup();

    const { goalId, tasks } = agentCore.startGoal("user-1", ["do thing one", "do thing two", "fail this one"]);
    expect(tasks).toHaveLength(3);
    expect(tasks.every((t) => t.goalId === goalId)).toBe(true);
    expect(tasks.every((t) => t.state === "PENDING")).toBe(true);

    // Drain the queue: 3 tasks, one at a time by default.
    for (let i = 0; i < 3; i++) {
      const processed = await agentCore.runQueueTick();
      expect(processed).toHaveLength(1);
    }

    const progress = agentCore.getGoalProgress(goalId);
    expect(progress.total).toBe(3);
    expect(progress.completed).toBe(2);
    expect(progress.failed).toBe(1);
    expect(progress.inProgress).toBe(0);
    expect(progress.waiting).toBe(0);
  });

  test("getGoalProgress for an unknown/empty goalId returns all zeros, not an error", () => {
    const { agentCore } = setup();
    const progress = agentCore.getGoalProgress("no-such-goal");
    expect(progress).toEqual({ goalId: "no-such-goal", total: 0, completed: 0, failed: 0, cancelled: 0, inProgress: 0, waiting: 0 });
  });
});

describe("AgentCore: Dependencies + Waiting States", () => {
  test("a task depending on an unfinished task stays WAITING and never plans", async () => {
    const { agentCore, taskStore, planner } = setup();
    const dependency = taskStore.create({ userId: "user-1", goal: "the prerequisite" }); // left PENDING, never run

    const result = await agentCore.runTask("user-1", "the dependent goal", { dependsOnTaskId: dependency.id });

    expect(result.state).toBe("WAITING");
    expect(planner.planCalls).not.toContain("the dependent goal");
  });

  test("once the dependency COMPLETEs, a queue tick resumes the WAITING task and it runs", async () => {
    const { agentCore, taskStore, planner } = setup();
    const dependency = await agentCore.runTask("user-1", "the prerequisite");
    expect(dependency.state).toBe("COMPLETED");

    const dependent = agentCore.enqueueTask("user-1", "the dependent goal", { dependsOnTaskId: dependency.id });
    expect(dependent.state).toBe("PENDING");

    const processed = await agentCore.runQueueTick();
    expect(processed).toHaveLength(1);
    expect(processed[0]?.id).toBe(dependent.id);
    expect(processed[0]?.state).toBe("COMPLETED");
    expect(planner.planCalls).toContain("the dependent goal");
  });

  test("a dependency that itself FAILs permanently fails the dependent task too, without ever planning it", async () => {
    const { agentCore, taskStore, planner } = setup();
    const dependency = await agentCore.runTask("user-1", "fail this prerequisite");
    expect(dependency.state).toBe("FAILED");

    const result = await agentCore.runTask("user-1", "the dependent goal", { dependsOnTaskId: dependency.id });

    expect(result.state).toBe("FAILED");
    expect(result.failureReason).toMatch(/dependency task .* ended in FAILED/i);
    expect(planner.planCalls).not.toContain("the dependent goal");
  });

  test("a task with an already-satisfied dependency runs immediately, no WAITING detour", async () => {
    const { agentCore } = setup();
    const dependency = await agentCore.runTask("user-1", "the prerequisite");
    expect(dependency.state).toBe("COMPLETED");

    const result = await agentCore.runTask("user-1", "the dependent goal", { dependsOnTaskId: dependency.id });
    expect(result.state).toBe("COMPLETED");
  });
});

describe("AgentCore: Priority Queue + Background Worker", () => {
  test("runQueueTick processes the highest-priority PENDING task first, ties broken by creation order", async () => {
    const { agentCore } = setup();
    const low = agentCore.enqueueTask("user-1", "low priority", { priority: 1 });
    const high = agentCore.enqueueTask("user-1", "high priority", { priority: 10 });
    const mid = agentCore.enqueueTask("user-1", "mid priority", { priority: 5 });

    const order: string[] = [];
    for (let i = 0; i < 3; i++) {
      const [processed] = await agentCore.runQueueTick();
      order.push(processed!.id);
    }

    expect(order).toEqual([high.id, mid.id, low.id]);
  });

  test("an empty queue processes nothing and returns an empty array", async () => {
    const { agentCore } = setup();
    const processed = await agentCore.runQueueTick();
    expect(processed).toEqual([]);
  });

  test("queueConcurrency > 1 processes multiple eligible tasks in one tick", async () => {
    const { agentCore } = setup({ queueConcurrency: 3 });
    agentCore.enqueueTask("user-1", "a");
    agentCore.enqueueTask("user-1", "b");
    agentCore.enqueueTask("user-1", "c");

    const processed = await agentCore.runQueueTick();
    expect(processed).toHaveLength(3);
    expect(processed.every((t) => t.state === "COMPLETED")).toBe(true);
  });
});

describe("AgentCore: Resume After Restart", () => {
  test("marks every non-terminal task FAILED with a clear restart-interrupted reason, and leaves PENDING/terminal tasks untouched", () => {
    const { agentCore, taskStore } = setup();

    const pending = taskStore.create({ userId: "user-1", goal: "never started" });

    const planning = taskStore.create({ userId: "user-1", goal: "was planning" });
    taskStore.setState(planning.id, "PLANNING");

    const executing = taskStore.create({ userId: "user-1", goal: "was executing" });
    taskStore.setState(executing.id, "PLANNING");
    taskStore.setState(executing.id, "EXECUTING");

    const verifying = taskStore.create({ userId: "user-1", goal: "was verifying" });
    taskStore.setState(verifying.id, "PLANNING");
    taskStore.setState(verifying.id, "EXECUTING");
    taskStore.setState(verifying.id, "VERIFYING");

    const retrying = taskStore.create({ userId: "user-1", goal: "was retrying" });
    taskStore.setState(retrying.id, "PLANNING");
    taskStore.setState(retrying.id, "EXECUTING");
    taskStore.setState(retrying.id, "RETRYING");

    const recovering = taskStore.create({ userId: "user-1", goal: "was recovering" });
    taskStore.setState(recovering.id, "PLANNING");
    taskStore.setState(recovering.id, "EXECUTING");
    taskStore.setState(recovering.id, "RECOVERING");

    const waiting = taskStore.create({ userId: "user-1", goal: "was waiting" });
    taskStore.setState(waiting.id, "PLANNING");
    taskStore.setState(waiting.id, "EXECUTING");
    taskStore.setState(waiting.id, "WAITING");

    const alreadyDone = taskStore.create({ userId: "user-1", goal: "already done" });
    taskStore.setState(alreadyDone.id, "PLANNING");
    taskStore.setState(alreadyDone.id, "CANCELLED");

    const resumed = agentCore.resumeIncompleteTasks();
    const resumedIds = resumed.map((t) => t.id).sort();
    expect(resumedIds).toEqual([planning.id, executing.id, verifying.id, retrying.id, recovering.id, waiting.id].sort());

    for (const failed of resumed) {
      expect(failed.state).toBe("FAILED");
      expect(failed.failureReason).toMatch(/interrupted by restart/i);
    }

    expect(taskStore.get(pending.id)?.state).toBe("PENDING");
    expect(taskStore.get(pending.id)?.failureReason).toBeNull();
    expect(taskStore.get(alreadyDone.id)?.state).toBe("CANCELLED");
  });

  test("resumeIncompleteTasks is a no-op when every task is already terminal or PENDING", () => {
    const { agentCore, taskStore } = setup();
    taskStore.create({ userId: "user-1", goal: "fresh" });
    expect(agentCore.resumeIncompleteTasks()).toEqual([]);
  });
});

describe("AgentCore: Agent Progress API", () => {
  test("getTaskProgress reports plan/step progress for an in-flight task", async () => {
    const { agentCore, taskStore } = setup();
    const task = taskStore.create({ userId: "user-1", goal: "goal" });
    taskStore.setPlan(task.id, [
      { toolName: "a", input: {}, description: "step a" },
      { toolName: "b", input: {}, description: "step b" },
    ]);
    taskStore.markStepVerified(task.id, taskStore.get(task.id)!.plan[0]!.id, true, "ok");

    const progress = agentCore.getTaskProgress(task.id);
    expect(progress).toMatchObject({
      taskId: task.id,
      totalSteps: 2,
      stepsVerified: 1,
      percentComplete: 50,
      goalId: null,
    });
  });

  test("listActiveTasks excludes terminal tasks and can filter by user", async () => {
    const { agentCore } = setup();
    const active = await agentCore.enqueueTask("user-1", "still pending");
    const done = await agentCore.runTask("user-1", "will finish");
    agentCore.enqueueTask("user-2", "someone else's task");

    const mine = agentCore.listActiveTasks("user-1");
    expect(mine.map((t) => t.id)).toContain(active.id);
    expect(mine.map((t) => t.id)).not.toContain(done.id);

    const everyone = agentCore.listActiveTasks();
    expect(everyone.map((t) => t.id)).not.toContain(done.id);
  });
});
