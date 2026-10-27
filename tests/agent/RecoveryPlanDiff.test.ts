import { describe, test, expect } from "bun:test";
import { AgentCore } from "@/agent/AgentCore";
import { AgentTaskStore } from "@/agent/AgentTaskStore";
import { isLikelySameRecoveryStep } from "@/agent/recoveryPlanDiff";
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

const unusedBrain: Brain = {
  async chat(_request: BrainRequest): Promise<BrainResponse> {
    throw new Error("Brain.chat should never be invoked by AgentCore's step-execution path");
  },
};

class ScriptedPlanner implements AgentPlanner {
  planRequests: AgentPlanRequest[] = [];
  private planCalls = 0;

  constructor(private readonly plans: AgentStepProposal[][]) {}

  async plan(request: AgentPlanRequest): Promise<AgentStepProposal[]> {
    this.planRequests.push(request);
    const plan = this.plans[this.planCalls];
    this.planCalls++;
    return plan ?? [];
  }

  async verify(_request: AgentVerificationRequest): Promise<AgentVerificationResult> {
    return { verified: true, reason: "default stub verdict" };
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

function setup(options: { tools?: LocalTool[]; planner: AgentPlanner; agentCoreOptions?: ConstructorParameters<typeof AgentCore>[1] }) {
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
  });

  const taskStore = new AgentTaskStore(":memory:");
  const auditLog = new ToolAuditLog(":memory:");

  const agentCore = new AgentCore({ orchestrator, planner: options.planner, toolRegistry, taskStore, auditLog, eventBus }, options.agentCoreOptions);

  return { agentCore, taskStore, auditLog, permissionService, eventBus };
}

describe("isLikelySameRecoveryStep (unit)", () => {
  test("flags an exact repeat (same tool, same input)", () => {
    expect(
      isLikelySameRecoveryStep(
        { id: "1", description: "read the config file", toolName: "read_file", input: { path: "/etc/app.conf" }, status: "failed" },
        { description: "read the config file", toolName: "read_file", input: { path: "/etc/app.conf" } }
      )
    ).toBe(true);
  });

  test("flags a cosmetic repeat (same tool, same input modulo whitespace/case/type)", () => {
    expect(
      isLikelySameRecoveryStep(
        { id: "1", description: "retry 1", toolName: "set_limit", input: { count: 5 }, status: "failed" },
        { description: "retry 2", toolName: "set_limit", input: { count: "5" } }
      )
    ).toBe(true);
  });

  test("flags a near-identical rewording (word-set similarity above threshold) even with a slightly different input shape", () => {
    // 14 words, differing in exactly one (prep vs notes) — Jaccard
    // similarity (13/15 ≈ 0.867) clears DESCRIPTION_SIMILARITY_THRESHOLD
    // (0.85), and the input shape differs (an extra key) so this exercises
    // the description-based fallback signal specifically, not the input
    // equality check.
    expect(
      isLikelySameRecoveryStep(
        {
          id: "1",
          description: "create reminder for tomorrow morning at nine am about team standup meeting agenda prep",
          toolName: "create_reminder",
          input: { when: "tomorrow 9am" },
          status: "failed",
        },
        {
          description: "create reminder for tomorrow morning at nine am about team standup meeting agenda notes",
          toolName: "create_reminder",
          input: { when: "tomorrow 9am", note: "" },
        }
      )
    ).toBe(true);
  });

  test("does not flag a different tool", () => {
    expect(
      isLikelySameRecoveryStep(
        { id: "1", description: "do the thing", toolName: "tool_a", input: {}, status: "failed" },
        { description: "do the thing", toolName: "tool_b", input: {} }
      )
    ).toBe(false);
  });

  test("does not flag a genuinely different input and description, same tool", () => {
    expect(
      isLikelySameRecoveryStep(
        {
          id: "1",
          description: "send the report to accounting",
          toolName: "send_email",
          input: { to: "accounting@example.com", subject: "Report" },
          status: "failed",
        },
        { description: "notify the on-call engineer about the outage", toolName: "send_email", input: { to: "oncall@example.com", subject: "Outage" } }
      )
    ).toBe(false);
  });
});

describe("AgentCore recovery plan-diff escalation", () => {
  test("a genuinely different recovery plan still proceeds normally (unchanged behavior)", async () => {
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
      [{ toolName: "bad_tool", input: { mode: "x" }, description: "try mode x" }],
      [{ toolName: "good_tool", input: {}, description: "a completely different approach that works" }],
    ]);

    const { agentCore, permissionService, auditLog } = setup({ tools: [badTool, goodTool], planner });
    permissionService.grant("user-1", "BAD_TOOL");
    permissionService.grant("user-1", "GOOD_TOOL");

    const result = await agentCore.runTask("user-1", "goal that needs a genuinely different recovery plan");

    expect(result.state).toBe("COMPLETED");
    expect(planner.planCallCount).toBe(2);

    const events = auditLog.listAgentEvents({ taskId: result.id }).map((e) => e.event);
    expect(events).toContain("step.recover");
    expect(events).not.toContain("recovery.repeated_step_escalated");
  });

  test("a recovery plan that repeats the failed step (same tool, same input) escalates to WAITING instead of retrying", async () => {
    let executions = 0;
    const badTool = makeTool({
      name: "stubborn_bad_tool",
      requiredPermission: PermissionLevel.SAFE_ACTION,
      requiresVerification: false,
      execute: async () => {
        executions++;
        return { success: false, error: "Invalid input: this will never work" };
      },
    });

    // The "recovery" plan proposes the exact same tool call again, just
    // with a reworded description — exactly the failure mode the audit
    // flagged as unverified.
    const planner = new ScriptedPlanner([
      [{ toolName: "stubborn_bad_tool", input: { target: "widget" }, description: "update the widget" }],
      [{ toolName: "stubborn_bad_tool", input: { target: "widget" }, description: "try updating the widget again" }],
    ]);

    const { agentCore, permissionService, auditLog } = setup({
      tools: [badTool],
      planner,
      agentCoreOptions: { maxRecoveryCycles: 2, maxStepRetries: 0 },
    });
    permissionService.grant("user-1", "STUBBORN_BAD_TOOL");

    const result = await agentCore.runTask("user-1", "a goal whose only recovery idea is the same bad idea");

    // Escalated, not silently retried — and not run through to the
    // maxRecoveryCycles backstop either (recoveryCount stayed at 1, well
    // under the cap of 2), confirming this is an *earlier* trigger.
    expect(result.state).toBe("WAITING");
    expect(result.recoveryCount).toBe(1);
    expect(result.failureReason).toMatch(/same step again|essentially the same/i);
    // Only the first (failing) attempt actually executed the tool — the
    // repeated step was never run a second time.
    expect(executions).toBe(1);
    expect(planner.planCallCount).toBe(2);

    const events = auditLog.listAgentEvents({ taskId: result.id }).map((e) => e.event);
    expect(events).toContain("recovery.repeated_step_escalated");
  });

  test("maxRecoveryCycles still backstops a planner whose plans differ each time but keep failing for different reasons", async () => {
    const alwaysFails = makeTool({
      name: "always_fails_differently",
      requiredPermission: PermissionLevel.SAFE_ACTION,
      requiresVerification: false,
      execute: async () => ({ success: false, error: "Invalid input: broken" }),
    });

    // Each attempt is a meaningfully different tool input/description, so
    // the plan-diff check never fires — this is exactly the case item 4 in
    // the task says the cap must still catch.
    const planner = new ScriptedPlanner([
      [{ toolName: "always_fails_differently", input: { approach: "A" }, description: "try approach A" }],
      [{ toolName: "always_fails_differently", input: { approach: "B" }, description: "try a totally different approach B" }],
      [{ toolName: "always_fails_differently", input: { approach: "C" }, description: "try yet another different approach C" }],
    ]);

    const { agentCore, permissionService, auditLog } = setup({
      tools: [alwaysFails],
      planner,
      agentCoreOptions: { maxRecoveryCycles: 2, maxStepRetries: 0 },
    });
    permissionService.grant("user-1", "ALWAYS_FAILS_DIFFERENTLY");

    const result = await agentCore.runTask("user-1", "a goal whose varied recovery ideas all still fail");

    expect(result.state).toBe("FAILED");
    expect(result.failureReason).toMatch(/max recovery cycles/i);
    expect(planner.planCallCount).toBe(3);

    const events = auditLog.listAgentEvents({ taskId: result.id }).map((e) => e.event);
    expect(events).not.toContain("recovery.repeated_step_escalated");
  });

  test("resumeWaitingTask re-enters PLANNING for a task escalated by the plan-diff check", async () => {
    const badTool = makeTool({
      name: "once_bad_tool",
      requiredPermission: PermissionLevel.SAFE_ACTION,
      requiresVerification: false,
      execute: async () => ({ success: false, error: "Invalid input: nope" }),
    });
    const goodTool = makeTool({
      name: "finally_good_tool",
      requiredPermission: PermissionLevel.SAFE_ACTION,
      requiresVerification: false,
      execute: async () => ({ success: true, data: {} }),
    });

    const planner = new ScriptedPlanner([
      [{ toolName: "once_bad_tool", input: {}, description: "do the thing" }],
      [{ toolName: "once_bad_tool", input: {}, description: "do the thing again" }],
      // Only produced once the task is resumed after escalation — a human
      // gave guidance and the next replan genuinely differs.
      [{ toolName: "finally_good_tool", input: {}, description: "a different approach after guidance" }],
    ]);

    const { agentCore, permissionService } = setup({
      tools: [badTool, goodTool],
      planner,
      agentCoreOptions: { maxRecoveryCycles: 2, maxStepRetries: 0 },
    });
    permissionService.grant("user-1", "ONCE_BAD_TOOL");
    permissionService.grant("user-1", "FINALLY_GOOD_TOOL");

    const waiting = await agentCore.runTask("user-1", "a goal that needs human guidance mid-recovery");
    expect(waiting.state).toBe("WAITING");

    const resumed = await agentCore.resumeWaitingTask(waiting.id);
    expect(resumed.state).toBe("COMPLETED");
    expect(planner.planCallCount).toBe(3);
  });
});
