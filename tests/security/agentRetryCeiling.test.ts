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

const unusedBrain: Brain = {
  async chat(_request: BrainRequest): Promise<BrainResponse> {
    throw new Error("Brain.chat should never be invoked by AgentCore's step-execution path");
  },
};

/**
 * A planner that never gives up: every call to plan() proposes the same
 * single step, regardless of prior failures — simulating an adversarial
 * or simply broken planner that would keep the task in an unbounded
 * retry/recover loop forever if AgentCore had no hard ceiling of its own.
 */
class NeverGivesUpPlanner implements AgentPlanner {
  planCallCount = 0;
  async plan(_request: AgentPlanRequest): Promise<AgentStepProposal[]> {
    this.planCallCount++;
    return [{ toolName: "always_throws", input: {}, description: `attempt ${this.planCallCount}` }];
  }
  async verify(_request: AgentVerificationRequest): Promise<AgentVerificationResult> {
    return { verified: true, reason: "unreachable — the tool always throws before verification" };
  }
}

/**
 * Security: a tool that always throws must never cause AgentCore to
 * retry indefinitely within a single turn, or across task
 * retry/recovery cycles — going beyond the existing per-run tool-call
 * cap test (which bounds the number of DISTINCT tool calls a single
 * brain response can request) to specifically exercise AgentCore's own
 * retry/recovery ceiling (`AgentTaskStateMachine` state transitions
 * driven by `handleStepFailure`) using the library's DEFAULT options —
 * no test-supplied override of maxStepRetries/maxRecoveryCycles/
 * maxTotalSteps — proving the real, shipped ceiling is what actually
 * stops the loop, not just a ceiling a test configures for itself.
 */
describe("Security: a permanently-failing tool cannot cause unbounded AgentCore retries (default ceilings)", () => {
  test("a tool that always throws ends the task in FAILED, not stuck retrying forever, using AgentCore's default limits", async () => {
    let executions = 0;
    const alwaysThrows: LocalTool = {
      id: "ALWAYS_THROWS",
      name: "always_throws",
      description: "A tool that always throws a real exception (not just an { success: false } result).",
      inputSchema: { type: "object", properties: {} },
      requiredPermission: PermissionLevel.SAFE_ACTION,
      requiresVerification: false,
      target: "local",
      execute: async () => {
        executions++;
        throw new Error("Invalid input: this tool is permanently broken");
      },
    };

    const eventBus = new EventBus();
    const toolRegistry = new ToolRegistry();
    toolRegistry.registerTool(alwaysThrows);
    const permissionService = new PermissionService();
    permissionService.grant("user-1", "ALWAYS_THROWS");
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
    const planner = new NeverGivesUpPlanner();

    // Deliberately NO agentCoreOptions override — this exercises the real,
    // shipped defaults (DEFAULT_MAX_STEP_RETRIES=2,
    // DEFAULT_MAX_RECOVERY_CYCLES=2, DEFAULT_MAX_TOTAL_STEPS=20,
    // DEFAULT_TASK_TIMEOUT_MS=5min) — the actual production safety net,
    // not a test-configured one.
    const agentCore = new AgentCore({ orchestrator, planner, toolRegistry, taskStore, auditLog, eventBus });

    const result = await agentCore.runTask("user-1", "a goal built on a tool that can never succeed");

    // The task terminates — it does NOT hang, and it does NOT loop forever.
    expect(result.state).toBe("FAILED");
    expect(["max recovery cycles", "max tool steps"].some((needle) => result.failureReason?.toLowerCase().includes(needle))).toBe(
      true
    );

    // Bounded by the real default ceilings: with maxStepRetries=2 and
    // maxRecoveryCycles=2, the tool can execute at most
    // (maxStepRetries + 1) attempts per plan, across at most
    // (maxRecoveryCycles + 1) plans — i.e. a small, fixed, well-bounded
    // number of executions, never anything close to "forever".
    expect(executions).toBeGreaterThan(0);
    expect(executions).toBeLessThanOrEqual(20); // DEFAULT_MAX_TOTAL_STEPS
    expect(planner.planCallCount).toBeLessThanOrEqual(4); // initial plan + at most maxRecoveryCycles re-plans, with slack

    const persisted = taskStore.get(result.id);
    expect(persisted?.state).toBe("FAILED");
  }, 10_000);
});
