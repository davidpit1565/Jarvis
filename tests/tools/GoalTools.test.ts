import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { AgentCore } from "@/agent/AgentCore";
import { AgentTaskStore } from "@/agent/AgentTaskStore";
import { GoalStore } from "@/agent/GoalStore";
import type { AgentPlanRequest, AgentPlanner, AgentStepProposal, AgentVerificationRequest, AgentVerificationResult } from "@/agent/types";
import { Orchestrator } from "@/core/orchestrator/Orchestrator";
import { ConversationManager } from "@/core/conversation/ConversationManager";
import { EventBus } from "@/core/events/EventBus";
import { ToolRegistry } from "@/tools/registry/ToolRegistry";
import { PermissionService } from "@/permissions/PermissionService";
import { PermissionLevel } from "@/types/permissions";
import { ToolAuditLog } from "@/audit/ToolAuditLog";
import type { Brain, BrainRequest, BrainResponse } from "@/types/brain";
import { createCreateGoalTool } from "@/tools/agent/CreateGoalTool";
import { createCheckGoalProgressTool } from "@/tools/agent/CheckGoalProgressTool";
import { createCompleteGoalTool } from "@/tools/agent/CompleteGoalTool";
import { createCancelGoalTool } from "@/tools/agent/CancelGoalTool";

const unusedBrain: Brain = {
  async chat(_request: BrainRequest): Promise<BrainResponse> {
    throw new Error("Brain.chat should never be invoked in these tests");
  },
};

/** Never actually called by CreateGoalTool/CancelGoalTool (they only enqueue), but AgentCore needs some planner. */
class NeverPlanner implements AgentPlanner {
  async plan(_request: AgentPlanRequest): Promise<AgentStepProposal[]> {
    throw new Error("plan() should not run in these tests — tasks are only enqueued, never drained");
  }
  async verify(_request: AgentVerificationRequest): Promise<AgentVerificationResult> {
    throw new Error("verify() should not run in these tests");
  }
}

const context = { userId: "user-1", requestId: "req-1" };

function setup() {
  const eventBus = new EventBus();
  const toolRegistry = new ToolRegistry();
  const permissionService = new PermissionService();
  const conversation = new ConversationManager(eventBus);
  const orchestrator = new Orchestrator({ brain: unusedBrain, conversation, toolRegistry, permissionService, eventBus });

  const taskStore = new AgentTaskStore(":memory:");
  const goalStore = new GoalStore(":memory:");
  const auditLog = new ToolAuditLog(":memory:");
  const agentCore = new AgentCore({ orchestrator, planner: new NeverPlanner(), toolRegistry, taskStore, auditLog, eventBus });

  return { agentCore, taskStore, goalStore };
}

describe("CREATE_GOAL tool", () => {
  let env: ReturnType<typeof setup>;

  beforeEach(() => {
    env = setup();
  });

  afterEach(() => {
    env.taskStore.close();
    env.goalStore.close();
  });

  test("is a local tool requiring SAFE_ACTION", () => {
    const tool = createCreateGoalTool(env.goalStore, env.agentCore);
    expect(tool.target).toBe("local");
    expect(tool.requiredPermission).toBe(PermissionLevel.SAFE_ACTION);
    expect(tool.id).toBe("CREATE_GOAL");
  });

  test("creates a goal record and one PENDING task per step, sharing a goalId", async () => {
    const tool = createCreateGoalTool(env.goalStore, env.agentCore);
    const result = await tool.execute({ description: "Launch my app", steps: ["Write landing page", "Submit to store"] }, context);

    expect(result.success).toBe(true);
    const data = result.data as { goalId: string; steps: { taskId: string; state: string }[] };
    expect(data.steps).toHaveLength(2);
    expect(data.steps.every((s) => s.state === "PENDING")).toBe(true);

    const goal = env.goalStore.get(data.goalId);
    expect(goal?.description).toBe("Launch my app");
    expect(goal?.status).toBe("active");
    expect(env.taskStore.listForGoal(data.goalId)).toHaveLength(2);
  });

  test("rejects an empty description", async () => {
    const tool = createCreateGoalTool(env.goalStore, env.agentCore);
    const result = await tool.execute({ description: "", steps: ["a"] }, context);
    expect(result.success).toBe(false);
  });

  test("rejects zero steps", async () => {
    const tool = createCreateGoalTool(env.goalStore, env.agentCore);
    const result = await tool.execute({ description: "Goal", steps: [] }, context);
    expect(result.success).toBe(false);
  });

  test("rejects more than the maximum number of steps (AutoGPT-style runaway-plan guard)", async () => {
    const tool = createCreateGoalTool(env.goalStore, env.agentCore);
    const steps = Array.from({ length: 13 }, (_, i) => `step ${i}`);
    const result = await tool.execute({ description: "Goal", steps }, context);
    expect(result.success).toBe(false);
    expect(env.taskStore.list()).toHaveLength(0);
  });

  test("rejects a non-array steps value", async () => {
    const tool = createCreateGoalTool(env.goalStore, env.agentCore);
    const result = await tool.execute({ description: "Goal", steps: "not an array" as never }, context);
    expect(result.success).toBe(false);
  });
});

describe("CHECK_GOAL_PROGRESS tool", () => {
  let env: ReturnType<typeof setup>;

  beforeEach(() => {
    env = setup();
  });

  afterEach(() => {
    env.taskStore.close();
    env.goalStore.close();
  });

  test("is read-only", () => {
    const tool = createCheckGoalProgressTool(env.goalStore, env.taskStore);
    expect(tool.requiredPermission).toBe(PermissionLevel.READ);
  });

  test("lists active goals with aggregate progress when no goalId is given", async () => {
    const createTool = createCreateGoalTool(env.goalStore, env.agentCore);
    await createTool.execute({ description: "Goal A", steps: ["s1", "s2"] }, context);

    const tool = createCheckGoalProgressTool(env.goalStore, env.taskStore);
    const result = await tool.execute({}, context);

    expect(result.success).toBe(true);
    const data = result.data as { goals: { description: string; progress: { total: number } }[] };
    expect(data.goals).toHaveLength(1);
    expect(data.goals[0]?.description).toBe("Goal A");
    expect(data.goals[0]?.progress.total).toBe(2);
  });

  test("returns a step-by-step breakdown for a specific goalId", async () => {
    const createTool = createCreateGoalTool(env.goalStore, env.agentCore);
    const created = await createTool.execute({ description: "Goal A", steps: ["s1", "s2"] }, context);
    const goalId = (created.data as { goalId: string }).goalId;

    const tool = createCheckGoalProgressTool(env.goalStore, env.taskStore);
    const result = await tool.execute({ goalId }, context);

    expect(result.success).toBe(true);
    const data = result.data as { steps: { step: string; state: string }[] };
    expect(data.steps).toHaveLength(2);
  });

  test("fails for an unknown goalId", async () => {
    const tool = createCheckGoalProgressTool(env.goalStore, env.taskStore);
    const result = await tool.execute({ goalId: "missing" }, context);
    expect(result.success).toBe(false);
  });
});

describe("COMPLETE_GOAL tool", () => {
  let env: ReturnType<typeof setup>;

  beforeEach(() => {
    env = setup();
  });

  afterEach(() => {
    env.taskStore.close();
    env.goalStore.close();
  });

  test("is a local tool requiring SAFE_ACTION", () => {
    const tool = createCompleteGoalTool(env.goalStore);
    expect(tool.requiredPermission).toBe(PermissionLevel.SAFE_ACTION);
  });

  test("marks a goal completed", async () => {
    const goal = env.goalStore.create({ userId: context.userId, description: "Goal A" });
    const tool = createCompleteGoalTool(env.goalStore);
    const result = await tool.execute({ goalId: goal.id }, context);

    expect(result.success).toBe(true);
    expect(env.goalStore.get(goal.id)?.status).toBe("completed");
  });

  test("fails for an unknown goalId", async () => {
    const tool = createCompleteGoalTool(env.goalStore);
    const result = await tool.execute({ goalId: "missing" }, context);
    expect(result.success).toBe(false);
  });

  test("fails for a goal belonging to a different user", async () => {
    const goal = env.goalStore.create({ userId: "someone-else", description: "Not yours" });
    const tool = createCompleteGoalTool(env.goalStore);
    const result = await tool.execute({ goalId: goal.id }, context);
    expect(result.success).toBe(false);
    expect(env.goalStore.get(goal.id)?.status).toBe("active");
  });
});

describe("CANCEL_GOAL tool", () => {
  let env: ReturnType<typeof setup>;

  beforeEach(() => {
    env = setup();
  });

  afterEach(() => {
    env.taskStore.close();
    env.goalStore.close();
  });

  test("marks the goal abandoned and cancels its still-pending tasks", async () => {
    const createTool = createCreateGoalTool(env.goalStore, env.agentCore);
    const created = await createTool.execute({ description: "Goal A", steps: ["s1", "s2"] }, context);
    const goalId = (created.data as { goalId: string }).goalId;

    const tool = createCancelGoalTool(env.goalStore, env.agentCore, env.taskStore);
    const result = await tool.execute({ goalId }, context);

    expect(result.success).toBe(true);
    expect(env.goalStore.get(goalId)?.status).toBe("abandoned");
    const data = result.data as { cancelledTaskIds: string[] };
    expect(data.cancelledTaskIds).toHaveLength(2);
  });

  test("fails for an unknown goalId", async () => {
    const tool = createCancelGoalTool(env.goalStore, env.agentCore, env.taskStore);
    const result = await tool.execute({ goalId: "missing" }, context);
    expect(result.success).toBe(false);
  });
});
