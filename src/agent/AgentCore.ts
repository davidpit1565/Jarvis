import { randomUUID } from "node:crypto";
import type { Orchestrator } from "@/core/orchestrator/Orchestrator";
import type { EventBus } from "@/core/events/EventBus";
import type { ToolRegistry } from "@/tools/registry/ToolRegistry";
import type { ToolAuditLog } from "@/audit/ToolAuditLog";
import type { ToolResult } from "@/types/tools";
import { toolRequiresVerification } from "@/tools/verificationPolicy";
import { AgentTaskStore } from "./AgentTaskStore";
import type { AgentPlanner, AgentTaskRecord } from "./types";
import { classifyError } from "./errorClassification";
import { AgentTimeoutError, withTimeout } from "./timeout";
import type { AgentTaskState } from "./AgentTaskStateMachine";

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * Hard cap on total tool-call steps a single task may execute (including
 * retries) — env-configurable (`JARVIS_AGENT_MAX_TOOL_STEPS`) but always
 * enforced; this is a real safety boundary against a runaway plan/retry/
 * recover loop, not a suggestion the loop can talk its way past.
 */
const DEFAULT_MAX_TOTAL_STEPS = readEnvInt("JARVIS_AGENT_MAX_TOOL_STEPS", 20);
const DEFAULT_MAX_STEP_RETRIES = readEnvInt("JARVIS_AGENT_MAX_STEP_RETRIES", 2);
const DEFAULT_MAX_RECOVERY_CYCLES = readEnvInt("JARVIS_AGENT_MAX_RECOVERY_CYCLES", 2);
const DEFAULT_STEP_TIMEOUT_MS = readEnvInt("JARVIS_AGENT_STEP_TIMEOUT_MS", 30_000);
const DEFAULT_TASK_TIMEOUT_MS = readEnvInt("JARVIS_AGENT_TASK_TIMEOUT_MS", 5 * 60_000);

export interface AgentCoreDependencies {
  orchestrator: Orchestrator;
  planner: AgentPlanner;
  toolRegistry: ToolRegistry;
  taskStore: AgentTaskStore;
  auditLog: ToolAuditLog;
  eventBus?: EventBus;
}

export interface AgentCoreOptions {
  maxTotalSteps?: number;
  maxStepRetries?: number;
  maxRecoveryCycles?: number;
  stepTimeoutMs?: number;
  taskTimeoutMs?: number;
}

export class AgentTaskCancelledError extends Error {
  constructor() {
    super("Agent task was cancelled");
    this.name = "AgentTaskCancelledError";
  }
}

/**
 * The Autonomous Agent Core: Plan -> Execute -> Verify -> Recover, on top
 * of the existing Orchestrator/PermissionService/ToolRegistry pipeline.
 * This class never executes a tool itself — every step goes through
 * `Orchestrator.executeToolCall`, so PermissionService, the lockdown
 * kill-switch, and ConfirmationService's per-invocation human confirmation
 * all apply to an agent step exactly as they do to a normal chat turn.
 *
 * An explicit opt-in entry point (`runTask`) — this never runs as a side
 * effect of `Orchestrator.handleUserMessage`, which is unchanged.
 */
export class AgentCore {
  private readonly cancelled = new Set<string>();
  private readonly options: Required<AgentCoreOptions>;

  constructor(
    private readonly deps: AgentCoreDependencies,
    options: AgentCoreOptions = {}
  ) {
    this.options = {
      maxTotalSteps: options.maxTotalSteps ?? DEFAULT_MAX_TOTAL_STEPS,
      maxStepRetries: options.maxStepRetries ?? DEFAULT_MAX_STEP_RETRIES,
      maxRecoveryCycles: options.maxRecoveryCycles ?? DEFAULT_MAX_RECOVERY_CYCLES,
      stepTimeoutMs: options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
      taskTimeoutMs: options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
    };
  }

  /** Creates a new agent task for `goal` and runs it to completion (COMPLETED, FAILED, or CANCELLED). */
  async runTask(userId: string, goal: string): Promise<AgentTaskRecord> {
    const task = this.deps.taskStore.create({ userId, goal });
    return this.runTaskLoop(task.id, Date.now());
  }

  /** Marks a task cancelled; the loop stops before its next step rather than mid-flight. */
  cancel(taskId: string): void {
    this.cancelled.add(taskId);
  }

  private isCancelled(taskId: string): boolean {
    return this.cancelled.has(taskId);
  }

  private emitTransition(task: AgentTaskRecord, to: AgentTaskState, reason: string): AgentTaskRecord {
    const from = task.state;
    const updated = this.deps.taskStore.setState(task.id, to);
    this.deps.auditLog.recordAgentEvent(task.id, task.userId, "state.transition", { from, to, reason });
    this.deps.eventBus?.emit("agent.task.transition", { taskId: task.id, userId: task.userId, from, to, reason });
    return updated;
  }

  private async fail(task: AgentTaskRecord, reason: string): Promise<AgentTaskRecord> {
    let updated = this.deps.taskStore.setFailureReason(task.id, reason);
    updated = this.emitTransition(updated, "FAILED", reason);
    return updated;
  }

  private async runTaskLoop(taskId: string, startedAtMs: number): Promise<AgentTaskRecord> {
    const { maxTotalSteps, maxStepRetries, maxRecoveryCycles, stepTimeoutMs, taskTimeoutMs } = this.options;
    let task = this.deps.taskStore.requireOrThrow(taskId);
    task = this.emitTransition(task, "PLANNING", "task started");

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (this.isCancelled(taskId)) {
        task = this.emitTransition(task, "CANCELLED", "cancelled before next step");
        break;
      }

      if (Date.now() - startedAtMs > taskTimeoutMs) {
        task = await this.fail(task, `Task exceeded its total timeout of ${taskTimeoutMs}ms`);
        break;
      }

      if (task.state === "RECOVERING") {
        task = this.emitTransition(task, "PLANNING", "recovering: producing a fresh plan after a failure");
        continue;
      }

      if (task.state === "PLANNING") {
        const priorFailure = task.failureReason ?? undefined;
        const completedSteps = task.plan.filter((step) => step.status === "verified");

        const proposals = await this.deps.planner.plan({
          goal: task.goal,
          userId: task.userId,
          priorFailure,
          completedSteps,
        });
        this.deps.auditLog.recordAgentEvent(taskId, task.userId, "plan.produced", {
          stepCount: proposals.length,
          priorFailure,
        });

        if (proposals.length === 0) {
          task = await this.fail(task, "Planner returned an empty plan");
          break;
        }

        task = this.deps.taskStore.setPlan(taskId, proposals);
        task = this.emitTransition(task, "EXECUTING", "plan ready");
        continue;
      }

      if (task.state === "EXECUTING") {
        const step = task.plan[task.currentStepIndex];
        if (!step) {
          task = this.emitTransition(task, "COMPLETED", "all plan steps completed and verified");
          break;
        }

        if (task.totalStepsExecuted >= maxTotalSteps) {
          task = await this.fail(task, `Exceeded max tool steps (${maxTotalSteps})`);
          break;
        }

        const toolCall = { id: randomUUID(), toolName: step.toolName, input: step.input };
        let result: ToolResult;
        try {
          result = await withTimeout(
            this.deps.orchestrator.executeToolCall(task.userId, toolCall),
            stepTimeoutMs,
            `Step "${step.description}" timed out after ${stepTimeoutMs}ms`
          );
        } catch (error) {
          result = {
            success: false,
            error: error instanceof AgentTimeoutError ? error.message : error instanceof Error ? error.message : "Step failed",
          };
        }

        this.deps.auditLog.record(step.toolName, task.userId, step.input, result);
        task = this.deps.taskStore.recordStepResult(taskId, step.id, result);
        this.deps.auditLog.recordAgentEvent(taskId, task.userId, "step.executed", {
          stepId: step.id,
          toolName: step.toolName,
          result,
        });

        if (!result.success) {
          task = await this.handleStepFailure(task, result.error ?? "Step failed", maxStepRetries, maxRecoveryCycles);
          continue;
        }

        const tool = this.deps.toolRegistry.listTools().find((candidate) => candidate.name === step.toolName);
        const needsVerification = tool ? toolRequiresVerification(tool) : true;

        if (!needsVerification) {
          task = this.deps.taskStore.markStepVerified(taskId, step.id, true, "READ-level tool; no verification required");
          task = this.deps.taskStore.advanceStep(taskId);
          continue;
        }

        task = this.emitTransition(task, "VERIFYING", "step succeeded; verifying its claimed effect");
        continue;
      }

      if (task.state === "VERIFYING") {
        const step = task.plan[task.currentStepIndex];
        if (!step || !step.lastResult) {
          task = await this.fail(task, "Reached VERIFYING with no step result to verify — internal agent error");
          break;
        }

        const verification = await this.deps.planner.verify({
          step,
          result: step.lastResult,
          runVerificationTool: (toolName, input) =>
            this.deps.orchestrator.executeToolCall(task.userId, { id: randomUUID(), toolName, input }),
        });

        this.deps.auditLog.recordAgentEvent(taskId, task.userId, "step.verification", {
          stepId: step.id,
          verified: verification.verified,
          reason: verification.reason,
        });

        if (verification.verified) {
          task = this.deps.taskStore.markStepVerified(taskId, step.id, true, verification.reason);
          task = this.deps.taskStore.advanceStep(taskId);
          task = this.emitTransition(task, "EXECUTING", "verified; continuing plan");
          continue;
        }

        task = this.deps.taskStore.markStepVerified(taskId, step.id, false, verification.reason);
        task = await this.handleStepFailure(task, `Verification failed: ${verification.reason}`, maxStepRetries, maxRecoveryCycles);
        continue;
      }

      // No other state should keep the loop running.
      break;
    }

    return this.deps.taskStore.requireOrThrow(taskId);
  }

  /** Shared retry-vs-recover decision for both a raw step failure and a failed verification. */
  private async handleStepFailure(
    task: AgentTaskRecord,
    reason: string,
    maxStepRetries: number,
    maxRecoveryCycles: number
  ): Promise<AgentTaskRecord> {
    const classification = classifyError(reason);

    if (classification === "transient" && task.stepRetryCount < maxStepRetries) {
      task = this.emitTransition(task, "RETRYING", reason);
      task = this.deps.taskStore.incrementStepRetry(task.id);
      this.deps.auditLog.recordAgentEvent(task.id, task.userId, "step.retry", {
        reason,
        attempt: task.stepRetryCount,
        maxStepRetries,
      });
      task = this.emitTransition(task, "EXECUTING", "retrying the same step");
      return task;
    }

    if (task.recoveryCount >= maxRecoveryCycles) {
      return this.fail(
        this.deps.taskStore.setFailureReason(task.id, reason),
        `Exceeded max recovery cycles (${maxRecoveryCycles}) after: ${reason}`
      );
    }

    task = this.deps.taskStore.setFailureReason(task.id, reason);
    task = this.emitTransition(task, "RECOVERING", reason);
    task = this.deps.taskStore.incrementRecoveryCount(task.id);
    this.deps.auditLog.recordAgentEvent(task.id, task.userId, "step.recover", {
      reason,
      recoveryCount: task.recoveryCount,
      maxRecoveryCycles,
    });
    return task;
  }
}
