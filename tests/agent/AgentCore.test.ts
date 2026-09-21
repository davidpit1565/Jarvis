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
import { ConfirmationService, type ConfirmationRequest } from "@/core/confirmation/ConfirmationService";
import { JarvisLiveStateTracker } from "@/core/state/JarvisLiveState";
import type { Brain, BrainRequest, BrainResponse } from "@/types/brain";
import type { LocalTool, ToolResult } from "@/types/tools";

/** A Brain that throws if ever called — AgentCore/Orchestrator.executeToolCall must never touch it. */
const unusedBrain: Brain = {
  async chat(_request: BrainRequest): Promise<BrainResponse> {
    throw new Error("Brain.chat should never be invoked by AgentCore's step-execution path");
  },
};

/** Scripted AgentPlanner: one plan array per call to plan(), one verdict per call to verify(). */
class ScriptedPlanner implements AgentPlanner {
  planRequests: AgentPlanRequest[] = [];
  verifyRequests: AgentVerificationRequest[] = [];
  private planCalls = 0;
  private verifyCalls = 0;

  constructor(
    private readonly plans: AgentStepProposal[][],
    private readonly verdicts: AgentVerificationResult[] = []
  ) {}

  async plan(request: AgentPlanRequest): Promise<AgentStepProposal[]> {
    this.planRequests.push(request);
    const plan = this.plans[this.planCalls];
    this.planCalls++;
    return plan ?? [];
  }

  async verify(request: AgentVerificationRequest): Promise<AgentVerificationResult> {
    this.verifyRequests.push(request);
    const verdict = this.verdicts[this.verifyCalls];
    this.verifyCalls++;
    return verdict ?? { verified: true, reason: "default stub verdict" };
  }

  get planCallCount() {
    return this.planCalls;
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

function setup(options: {
  tools?: LocalTool[];
  planner: AgentPlanner;
  agentCoreOptions?: ConstructorParameters<typeof AgentCore>[1];
  confirmationService?: ConfirmationService;
}) {
  const eventBus = new EventBus();
  const toolRegistry = new ToolRegistry();
  for (const tool of options.tools ?? []) toolRegistry.registerTool(tool);
  const permissionService = new PermissionService();
  const conversation = new ConversationManager(eventBus);

  const orchestrator = new Orchestrator({
    brain: unusedBrain,
    conversation,
    toolRegistry,
    permissionService,
    eventBus,
    confirmationService: options.confirmationService,
  });

  const taskStore = new AgentTaskStore(":memory:");
  const auditLog = new ToolAuditLog(":memory:");

  const agentCore = new AgentCore(
    { orchestrator, planner: options.planner, toolRegistry, taskStore, auditLog, eventBus },
    options.agentCoreOptions
  );

  return { agentCore, taskStore, auditLog, permissionService, eventBus, toolRegistry };
}

describe("AgentCore", () => {
  test("runs a full plan to COMPLETED, verifying a mutating step and skipping verification for a READ step", async () => {
    const created: string[] = [];
    const createTool = makeTool({
      name: "create_thing",
      requiredPermission: PermissionLevel.SAFE_ACTION,
      execute: async (input) => {
        created.push(input.name as string);
        return { success: true, data: { name: input.name } };
      },
    });
    const listTool = makeTool({
      name: "list_things",
      requiredPermission: PermissionLevel.READ,
      execute: async () => ({ success: true, data: created }),
    });

    const planner = new ScriptedPlanner(
      [
        [
          { toolName: "create_thing", input: { name: "widget" }, description: "create the widget" },
          { toolName: "list_things", input: {}, description: "confirm it's listed" },
        ],
      ],
      [{ verified: true, reason: "widget shows up in a follow-up list" }]
    );

    const { agentCore, permissionService, taskStore, auditLog } = setup({ tools: [createTool, listTool], planner });
    permissionService.grant("user-1", "CREATE_THING");

    const result = await agentCore.runTask("user-1", "create a widget and confirm it exists");

    expect(result.state).toBe("COMPLETED");
    expect(created).toEqual(["widget"]);
    expect(result.plan[0]?.status).toBe("verified");
    expect(result.plan[1]?.status).toBe("verified");
    expect(result.plan[1]?.verificationReason).toMatch(/no verification required/i);

    const persisted = taskStore.get(result.id);
    expect(persisted?.state).toBe("COMPLETED");

    const events = auditLog.listAgentEvents({ taskId: result.id }).map((e) => e.event);
    expect(events).toContain("plan.produced");
    expect(events).toContain("step.executed");
    expect(events).toContain("step.verification");
    expect(events.filter((e) => e === "state.transition").length).toBeGreaterThan(3);
  });

  test("agent.task.transition events carry a safe, user-facing phase alongside the raw from/to states", async () => {
    const tool = makeTool({
      name: "read_tool",
      requiredPermission: PermissionLevel.READ,
      execute: async () => ({ success: true, data: {} }),
    });
    const planner = new ScriptedPlanner([[{ toolName: "read_tool", input: {}, description: "a step" }]]);
    const { agentCore, eventBus } = setup({ tools: [tool], planner });

    const seenPhases: Array<{ to: string; phase?: string }> = [];
    eventBus.on("agent.task.transition", ({ to, phase }) => seenPhases.push({ to, phase }));

    const result = await agentCore.runTask("user-1", "a goal to watch phases for");

    expect(result.state).toBe("COMPLETED");
    expect(seenPhases.length).toBeGreaterThan(0);
    for (const { to, phase } of seenPhases) {
      expect(phase).toBeDefined();
      if (to === "PLANNING") expect(phase).toBe("PLANNING");
      if (to === "EXECUTING") expect(phase).toBe("EXECUTING");
      if (to === "COMPLETED") expect(phase).toBe("COMPLETED");
    }
  });

  test("fails the task cleanly when the planner returns an empty plan", async () => {
    const planner = new ScriptedPlanner([[]]);
    const { agentCore } = setup({ tools: [], planner });

    const result = await agentCore.runTask("user-1", "do something impossible");

    expect(result.state).toBe("FAILED");
    expect(result.failureReason).toMatch(/empty plan/i);
  });

  test("retries a step that fails transiently, then succeeds", async () => {
    let attempts = 0;
    const flaky = makeTool({
      name: "flaky_tool",
      requiredPermission: PermissionLevel.SAFE_ACTION,
      requiresVerification: false,
      execute: async () => {
        attempts++;
        if (attempts === 1) return { success: false, error: "upstream request timed out" };
        return { success: true, data: { attempts } };
      },
    });

    const planner = new ScriptedPlanner([[{ toolName: "flaky_tool", input: {}, description: "flaky step" }]]);
    const { agentCore, permissionService, auditLog } = setup({ tools: [flaky], planner });
    permissionService.grant("user-1", "FLAKY_TOOL");

    const result = await agentCore.runTask("user-1", "run the flaky tool");

    expect(result.state).toBe("COMPLETED");
    expect(attempts).toBe(2);
    const events = auditLog.listAgentEvents({ taskId: result.id }).map((e) => e.event);
    expect(events).toContain("step.retry");
  });

  test("goes to RECOVERING and re-plans after a permanent step failure, then succeeds", async () => {
    const badTool = makeTool({
      name: "bad_tool",
      requiredPermission: PermissionLevel.SAFE_ACTION,
      requiresVerification: false,
      execute: async () => ({ success: false, error: "Invalid input: missing field" }),
    });
    const goodTool = makeTool({
      name: "good_tool",
      requiredPermission: PermissionLevel.SAFE_ACTION,
      requiresVerification: false,
      execute: async () => ({ success: true, data: {} }),
    });

    const planner = new ScriptedPlanner([
      [{ toolName: "bad_tool", input: {}, description: "this will fail permanently" }],
      [{ toolName: "good_tool", input: {}, description: "a different plan that works" }],
    ]);

    const { agentCore, permissionService, auditLog } = setup({ tools: [badTool, goodTool], planner });
    permissionService.grant("user-1", "BAD_TOOL");
    permissionService.grant("user-1", "GOOD_TOOL");

    const result = await agentCore.runTask("user-1", "goal that needs a retry plan");

    expect(result.state).toBe("COMPLETED");
    expect(planner.planCallCount).toBe(2);
    expect(planner.planRequests[1]?.priorFailure).toMatch(/invalid input/i);

    const events = auditLog.listAgentEvents({ taskId: result.id }).map((e) => e.event);
    expect(events).toContain("step.recover");
  });

  test("fails after exhausting max recovery cycles", async () => {
    const alwaysFails = makeTool({
      name: "always_fails",
      requiredPermission: PermissionLevel.SAFE_ACTION,
      requiresVerification: false,
      execute: async () => ({ success: false, error: "Invalid input: always broken" }),
    });

    const planner = new ScriptedPlanner([
      [{ toolName: "always_fails", input: {}, description: "step 1" }],
      [{ toolName: "always_fails", input: {}, description: "step 1 retry" }],
      [{ toolName: "always_fails", input: {}, description: "step 1 retry 2" }],
    ]);

    const { agentCore, permissionService } = setup({
      tools: [alwaysFails],
      planner,
      agentCoreOptions: { maxRecoveryCycles: 2, maxStepRetries: 0 },
    });
    permissionService.grant("user-1", "ALWAYS_FAILS");

    const result = await agentCore.runTask("user-1", "a goal that can never succeed");

    expect(result.state).toBe("FAILED");
    expect(result.failureReason).toMatch(/max recovery cycles/i);
  });

  test("enforces the hard max-total-steps cap even when the plan has more steps", async () => {
    const tool = makeTool({
      name: "step_tool",
      requiredPermission: PermissionLevel.READ,
      execute: async () => ({ success: true, data: {} }),
    });

    const planner = new ScriptedPlanner([
      [
        { toolName: "step_tool", input: {}, description: "step 1" },
        { toolName: "step_tool", input: {}, description: "step 2" },
      ],
    ]);

    const { agentCore } = setup({ tools: [tool], planner, agentCoreOptions: { maxTotalSteps: 1 } });

    const result = await agentCore.runTask("user-1", "a goal with too many steps");

    expect(result.state).toBe("FAILED");
    expect(result.failureReason).toMatch(/max tool steps/i);
    expect(result.totalStepsExecuted).toBe(1);
  });

  test("fails cleanly on a per-step timeout instead of hanging", async () => {
    const hangingTool = makeTool({
      name: "hanging_tool",
      requiredPermission: PermissionLevel.READ,
      execute: () => new Promise<ToolResult>(() => {}), // never resolves
    });

    const planner = new ScriptedPlanner([[{ toolName: "hanging_tool", input: {}, description: "will hang" }]]);
    const { agentCore } = setup({
      tools: [hangingTool],
      planner,
      agentCoreOptions: { stepTimeoutMs: 20, maxStepRetries: 0, maxRecoveryCycles: 0 },
    });

    const result = await agentCore.runTask("user-1", "run the hanging tool");

    expect(result.state).toBe("FAILED");
    expect(result.failureReason).toMatch(/timed out/i);
  });

  test("fails cleanly on a total task timeout", async () => {
    let calls = 0;
    const slowEachTime = makeTool({
      name: "slow_tool",
      requiredPermission: PermissionLevel.READ,
      execute: async () => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { success: false, error: "upstream request timed out" };
      },
    });

    const planner = new ScriptedPlanner([[{ toolName: "slow_tool", input: {}, description: "slow step" }]]);
    const { agentCore } = setup({
      tools: [slowEachTime],
      planner,
      agentCoreOptions: { taskTimeoutMs: 50, stepTimeoutMs: 5_000, maxStepRetries: 10, maxRecoveryCycles: 10 },
    });

    const result = await agentCore.runTask("user-1", "a task that overall takes too long");

    expect(result.state).toBe("FAILED");
    expect(result.failureReason).toMatch(/total timeout/i);
    expect(calls).toBeGreaterThan(0);
  });

  test("cancel() stops the loop before any step actually runs, once requested early enough", async () => {
    let firstStepRan = false;
    let secondStepRan = false;
    const step1 = makeTool({
      name: "step_one",
      requiredPermission: PermissionLevel.READ,
      execute: async () => {
        firstStepRan = true;
        return { success: true, data: {} };
      },
    });
    const step2 = makeTool({
      name: "step_two",
      requiredPermission: PermissionLevel.READ,
      execute: async () => {
        secondStepRan = true;
        return { success: true, data: {} };
      },
    });

    const planner = new ScriptedPlanner([
      [
        { toolName: "step_one", input: {}, description: "first step" },
        { toolName: "step_two", input: {}, description: "second step" },
      ],
    ]);

    const { agentCore, taskStore } = setup({ tools: [step1, step2], planner });

    // runTask runs synchronously up to its first `await` (inside planner.plan()),
    // so the task already exists in the store the instant control returns here —
    // cancel() lands before the loop's next cancellation check ever runs a step.
    const runPromise = agentCore.runTask("user-1", "a cancellable goal");
    const [task] = taskStore.list("user-1");
    expect(task).toBeDefined();
    agentCore.cancel(task!.id);

    const result = await runPromise;

    expect(result.state).toBe("CANCELLED");
    expect(firstStepRan).toBe(false);
    expect(secondStepRan).toBe(false);
  });

  test("Orchestrator.requestStop cancels an in-flight multi-step agent task, leaving it cleanly CANCELLED with no further tool calls", async () => {
    let step2Ran = false;
    const eventBus = new EventBus();
    const toolRegistry = new ToolRegistry();
    const permissionService = new PermissionService();
    const conversation = new ConversationManager(eventBus);
    const liveState = new JarvisLiveStateTracker(eventBus);
    const taskStore = new AgentTaskStore(":memory:");
    const auditLog = new ToolAuditLog(":memory:");

    // Mirrors the real production wiring in src/index.ts: `orchestrator`
    // needs the cancel hook at construction time, but the hook needs
    // `agentCore`, which itself needs `orchestrator` — the forward-ref box
    // breaks that ordering cycle in the test the same way it does in
    // src/index.ts.
    let agentCoreRef: AgentCore | undefined;
    const orchestrator = new Orchestrator({
      brain: unusedBrain,
      conversation,
      toolRegistry,
      permissionService,
      eventBus,
      liveState,
      agentTaskCanceller: {
        cancelActiveTasksForUser: (userId) => agentCoreRef?.cancelActiveTasksForUser(userId) ?? [],
      },
    });

    const step1 = makeTool({
      name: "step_one",
      requiredPermission: PermissionLevel.READ,
      execute: async () => {
        // Simulates a Stop button click arriving while this step is
        // actually in flight — the exact race item 4 needs verified safe.
        const stopped = orchestrator.requestStop("user-1");
        expect(stopped).toBe(true);
        return { success: true, data: {} };
      },
    });
    const step2 = makeTool({
      name: "step_two",
      requiredPermission: PermissionLevel.READ,
      execute: async () => {
        step2Ran = true;
        return { success: true, data: {} };
      },
    });
    toolRegistry.registerTool(step1);
    toolRegistry.registerTool(step2);

    const planner = new ScriptedPlanner([
      [
        { toolName: "step_one", input: {}, description: "first step" },
        { toolName: "step_two", input: {}, description: "second step" },
      ],
    ]);

    const agentCore = new AgentCore({ orchestrator, planner, toolRegistry, taskStore, auditLog, eventBus, liveState });
    agentCoreRef = agentCore;

    const result = await agentCore.runTask("user-1", "a multi-step goal interrupted mid-flight");

    expect(result.state).toBe("CANCELLED");
    expect(step2Ran).toBe(false);
    // No corruption / no silent completion: the persisted store agrees
    // exactly with what runTask returned.
    expect(taskStore.get(result.id)?.state).toBe("CANCELLED");
    expect(taskStore.get(result.id)?.completedAt).not.toBeNull();
  });

  test("Orchestrator.requestStop is a no-op (returns false) when the user has no active chat turn or agent task", () => {
    const eventBus = new EventBus();
    const toolRegistry = new ToolRegistry();
    const permissionService = new PermissionService();
    const conversation = new ConversationManager(eventBus);
    const liveState = new JarvisLiveStateTracker(eventBus);
    const orchestrator = new Orchestrator({
      brain: unusedBrain,
      conversation,
      toolRegistry,
      permissionService,
      eventBus,
      liveState,
      agentTaskCanceller: { cancelActiveTasksForUser: () => [] },
    });

    expect(orchestrator.requestStop("nobody-doing-anything")).toBe(false);
  });

  test("a CONFIRM-level step actually pauses for a real human confirmation before running", async () => {
    const confirmationRequests: ConfirmationRequest[] = [];
    const confirmationService = new ConfirmationService(async (request) => {
      confirmationRequests.push(request);
      return true;
    });

    let executed = false;
    const confirmTool = makeTool({
      name: "confirm_tool",
      requiredPermission: PermissionLevel.CONFIRM,
      requiresVerification: false,
      execute: async () => {
        executed = true;
        return { success: true, data: {} };
      },
    });

    const planner = new ScriptedPlanner([[{ toolName: "confirm_tool", input: {}, description: "needs confirmation" }]]);
    const { agentCore, permissionService } = setup({ tools: [confirmTool], planner, confirmationService });
    permissionService.grant("user-1", "CONFIRM_TOOL");

    const result = await agentCore.runTask("user-1", "do the thing that needs confirmation");

    expect(confirmationRequests).toHaveLength(1);
    expect(confirmationRequests[0]?.toolName).toBe("confirm_tool");
    expect(executed).toBe(true);
    expect(result.state).toBe("COMPLETED");
  });

  test("a declined confirmation fails the agent step instead of skipping the confirmation", async () => {
    const confirmationService = new ConfirmationService(async () => false);
    let executed = false;
    const confirmTool = makeTool({
      name: "confirm_tool_2",
      requiredPermission: PermissionLevel.CONFIRM,
      requiresVerification: false,
      execute: async () => {
        executed = true;
        return { success: true, data: {} };
      },
    });

    const planner = new ScriptedPlanner([[{ toolName: "confirm_tool_2", input: {}, description: "needs confirmation" }]]);
    const { agentCore, permissionService } = setup({
      tools: [confirmTool],
      planner,
      confirmationService,
      agentCoreOptions: { maxStepRetries: 0, maxRecoveryCycles: 0 },
    });
    permissionService.grant("user-1", "CONFIRM_TOOL_2");

    const result = await agentCore.runTask("user-1", "do the thing that will be declined");

    expect(executed).toBe(false);
    expect(result.state).toBe("FAILED");
    expect(result.failureReason).toMatch(/declined to confirm/i);
  });

  test("a DANGEROUS step without a standing permission grant is denied, not silently allowed because the agent is autonomous", async () => {
    let executed = false;
    const dangerousTool = makeTool({
      name: "dangerous_tool",
      requiredPermission: PermissionLevel.DANGEROUS,
      execute: async () => {
        executed = true;
        return { success: true, data: {} };
      },
    });

    const planner = new ScriptedPlanner([[{ toolName: "dangerous_tool", input: {}, description: "no grant for this" }]]);
    const { agentCore } = setup({
      tools: [dangerousTool],
      planner,
      agentCoreOptions: { maxStepRetries: 0, maxRecoveryCycles: 0 },
    });
    // Deliberately no permissionService.grant call.

    const result = await agentCore.runTask("user-1", "try to do something dangerous without permission");

    expect(executed).toBe(false);
    expect(result.state).toBe("FAILED");
    expect(result.failureReason).toMatch(/permission denied/i);
  });
});
