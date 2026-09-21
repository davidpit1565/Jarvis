import { randomUUID } from "node:crypto";
import type { Orchestrator } from "@/core/orchestrator/Orchestrator";
import type { EventBus } from "@/core/events/EventBus";
import type { ToolRegistry } from "@/tools/registry/ToolRegistry";
import type { ToolAuditLog } from "@/audit/ToolAuditLog";
import type { ToolResult } from "@/types/tools";
import { toolRequiresVerification } from "@/tools/verificationPolicy";
import { AgentTaskStore, type AgentTaskProgress, type GoalProgress } from "./AgentTaskStore";
import type { AgentPlanner, AgentTaskRecord } from "./types";
import { classifyError } from "./errorClassification";
import { AgentTimeoutError, withTimeout } from "./timeout";
import { isTerminalState, phaseForAgentTaskState, type AgentTaskState } from "./AgentTaskStateMachine";
import { liveStateForAgentTaskState, type JarvisLiveStateTracker } from "@/core/state/JarvisLiveState";

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
  /**
   * Optional: drives the user-facing JarvisLiveState machine
   * (src/core/state/JarvisLiveState.ts) alongside this task's own
   * AgentTaskStateMachine transitions, via `liveStateForAgentTaskState`.
   * Kept on a session key distinct from a plain chat Orchestrator's
   * ("agent:<userId>" vs. that Orchestrator's own "<channel>:<userId>"),
   * since an agent task and a live chat turn for the same user can run
   * concurrently and must not clobber each other's live state.
   */
  liveState?: JarvisLiveStateTracker;
}

export interface AgentCoreOptions {
  maxTotalSteps?: number;
  maxStepRetries?: number;
  maxRecoveryCycles?: number;
  stepTimeoutMs?: number;
  taskTimeoutMs?: number;
  /** How many queued tasks `runQueueTick` runs concurrently. Default 1 — same "one at a time" spirit as the codebase's other setInterval schedulers. */
  queueConcurrency?: number;
}

/** Optional extras for creating a task via `runTask`/`enqueueTask` — a goal link, a dependency, and/or a queue priority. */
export interface RunTaskOptions {
  /** Groups this task under a Goal — see AgentTaskRecord.goalId. */
  goalId?: string;
  /** This task will not start PLANNING until the referenced task COMPLETEs — see AgentTaskRecord.dependsOnTaskId. */
  dependsOnTaskId?: string;
  /** Higher runs first in the queue. Defaults to 0. Ignored by `runTask` itself (which always runs immediately), used by `enqueueTask`/`runQueueTick`. */
  priority?: number;
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
  /** Task ids currently being processed by `runQueueTick`, so overlapping ticks (or a concurrency > 1 tick) never pick up the same task twice. */
  private readonly inFlightQueueTasks = new Set<string>();

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
      queueConcurrency: options.queueConcurrency ?? 1,
    };
  }

  /** Creates a new agent task for `goal` and runs it to completion (COMPLETED, FAILED, CANCELLED, or WAITING on an unresolved dependency). */
  async runTask(userId: string, goal: string, options: RunTaskOptions = {}): Promise<AgentTaskRecord> {
    const task = this.deps.taskStore.create({
      userId,
      goal,
      goalId: options.goalId,
      dependsOnTaskId: options.dependsOnTaskId,
    });
    return this.runTaskLoop(task.id, Date.now());
  }

  /**
   * Creates a task without running it — roadmap items 31-32 (Persistent +
   * Priority Agent Queue). It sits PENDING in `AgentTaskStore` until a
   * `runQueueTick` call (normally driven by a `setInterval` in `src/index.ts`,
   * the same pattern as every other background loop there) picks it up.
   */
  enqueueTask(userId: string, goal: string, options: RunTaskOptions = {}): AgentTaskRecord {
    return this.deps.taskStore.create({
      userId,
      goal,
      goalId: options.goalId,
      dependsOnTaskId: options.dependsOnTaskId,
      priority: options.priority,
    });
  }

  /**
   * Starts a lightweight Goal (roadmap items 26-27): one new goalId shared
   * by one enqueued task per sub-goal string. Tasks are independent (no
   * auto-chained dependency) unless the caller passes its own via
   * `dependsOnTaskId` per sub-goal — this is intentionally not a planning
   * hierarchy, just a shared tag multiple tasks can be grouped and
   * progress-queried under via `getGoalProgress`.
   */
  startGoal(userId: string, subGoals: string[], options: { priority?: number } = {}): { goalId: string; tasks: AgentTaskRecord[] } {
    const goalId = randomUUID();
    const tasks = subGoals.map((goal) => this.enqueueTask(userId, goal, { goalId, priority: options.priority }));
    return { goalId, tasks };
  }

  /** Aggregate progress for a Goal — see AgentTaskStore.getGoalProgress. */
  getGoalProgress(goalId: string): GoalProgress {
    return this.deps.taskStore.getGoalProgress(goalId);
  }

  /** Poll-friendly progress snapshot for one task — roadmap item 34 (Agent Progress API). */
  getTaskProgress(taskId: string): AgentTaskProgress {
    return this.deps.taskStore.getProgress(taskId);
  }

  /** Every currently non-terminal task, optionally filtered to one user — roadmap item 34/107 (Live Activity / Active Tasks). */
  listActiveTasks(userId?: string): AgentTaskRecord[] {
    return this.deps.taskStore.listActive(userId);
  }

  /**
   * Runs up to `queueConcurrency` eligible queued tasks to completion (or
   * to their next WAITING/terminal state) — roadmap item 33 (Background
   * Agent Worker). Intended to be driven by a `setInterval` in
   * `src/index.ts`, exactly like the wake-up-call/automation-rule/reminder
   * loops there; each call is a single "tick", not a long-running loop
   * itself, so it composes with that pattern instead of introducing a new
   * one. Returns the tasks it processed this tick (possibly empty).
   */
  async runQueueTick(maxConcurrent: number = this.options.queueConcurrency): Promise<AgentTaskRecord[]> {
    const picked: AgentTaskRecord[] = [];
    for (let i = 0; i < maxConcurrent; i++) {
      const next = this.deps.taskStore.getNextEligibleQueuedTask(this.inFlightQueueTasks);
      if (!next) break;
      this.inFlightQueueTasks.add(next.id);
      picked.push(next);
    }
    if (picked.length === 0) return [];

    try {
      return await Promise.all(picked.map((task) => this.runTaskLoop(task.id, Date.now())));
    } finally {
      for (const task of picked) this.inFlightQueueTasks.delete(task.id);
    }
  }

  /**
   * Resume After Restart (roadmap item 30). `AgentTaskStore` already
   * persists every task's exact state, but nothing previously acted on a
   * task a restart caught mid-flight (PLANNING/EXECUTING/VERIFYING/
   * RETRYING/RECOVERING/WAITING) — it would just sit there forever,
   * invisible, never resumed and never marked failed.
   *
   * Deliberate, documented choice: this does NOT attempt to resume
   * mid-tool-execution — there is no way to know whether an interrupted
   * tool call actually completed on the far end (sent the email? not?)
   * before the process died, so blindly re-running it could double an
   * effect the original run may have already caused. The safe default is
   * to mark every such task FAILED with a clear "interrupted by restart"
   * reason instead, leaving a human/caller free to re-run the goal from
   * scratch if it's still wanted. A PENDING task (never even started
   * planning) is left untouched — nothing about it was in flight, and the
   * background queue will pick it up normally.
   *
   * Call this once at process startup, before the queue worker's first
   * tick, from `src/index.ts`.
   */
  resumeIncompleteTasks(): AgentTaskRecord[] {
    const interruptible: AgentTaskState[] = ["PLANNING", "EXECUTING", "VERIFYING", "RETRYING", "RECOVERING", "WAITING"];
    const affected: AgentTaskRecord[] = [];
    for (const state of interruptible) {
      for (const task of this.deps.taskStore.listByState(state)) {
        const withReason = this.deps.taskStore.setFailureReason(
          task.id,
          `Interrupted by restart: task was still ${state} when the process last stopped. Safe default: fail rather than risk an unsafe mid-tool-execution resume.`
        );
        affected.push(this.emitTransition(withReason, "FAILED", "process restart: task left non-terminal, failed instead of resumed"));
      }
    }
    return affected;
  }

  /** Marks a task cancelled; the loop stops before its next step rather than mid-flight. */
  cancel(taskId: string): void {
    this.cancelled.add(taskId);
  }

  /**
   * Marks every currently non-terminal task belonging to `userId` as
   * cancelled — the seam `Orchestrator.requestStop(userId)` calls (see its
   * `agentTaskCanceller` dependency) so a user-initiated Stop actually
   * reaches an in-flight AgentCore task, not just a plain chat turn.
   * Cooperative, same as `cancel()` itself: each affected task's own
   * `runTaskLoop` still settles into CANCELLED at its own next checkpoint
   * (before its next step), never mid-tool-call. Returns the ids of every
   * task this call marked — empty if the user had no active task.
   */
  cancelActiveTasksForUser(userId: string): string[] {
    const active = this.deps.taskStore.listActive(userId);
    for (const task of active) this.cancel(task.id);
    return active.map((task) => task.id);
  }

  private isCancelled(taskId: string): boolean {
    return this.cancelled.has(taskId);
  }

  /** The JarvisLiveState session key for one agent task's userId — see the `liveState` doc comment on AgentCoreDependencies. */
  private liveSessionId(userId: string): string {
    return `agent:${userId}`;
  }

  private emitTransition(task: AgentTaskRecord, to: AgentTaskState, reason: string): AgentTaskRecord {
    const from = task.state;
    const updated = this.deps.taskStore.setState(task.id, to);
    this.deps.auditLog.recordAgentEvent(task.id, task.userId, "state.transition", { from, to, reason });
    this.deps.eventBus?.emit("agent.task.transition", {
      taskId: task.id,
      userId: task.userId,
      from,
      to,
      reason,
      phase: phaseForAgentTaskState(to),
    });

    const { liveState } = this.deps;
    const mappedState = liveStateForAgentTaskState(to);
    if (liveState && mappedState) {
      const sessionId = this.liveSessionId(task.userId);
      liveState.transition(sessionId, task.userId, mappedState, { reason: `agent task ${task.id}: ${reason}` });
      // COMPLETED/FAILED/CANCELLED map onto SPEAKING/ERROR/STOPPED, all of
      // which only ever lead back to IDLE — settle there immediately so a
      // finished task doesn't leave its session stuck showing "speaking".
      if (to === "COMPLETED" || to === "FAILED" || to === "CANCELLED") {
        liveState.reset(sessionId, task.userId, `agent task ${task.id} ${to.toLowerCase()}`);
      }
    }

    return updated;
  }

  private async fail(task: AgentTaskRecord, reason: string): Promise<AgentTaskRecord> {
    let updated = this.deps.taskStore.setFailureReason(task.id, reason);
    updated = this.emitTransition(updated, "FAILED", reason);
    return updated;
  }

  /**
   * Roadmap items 28-29 (Dependencies/Waiting States): gates a PENDING/
   * WAITING task on `dependsOnTaskId`. Returns `{ ready: true }` when the
   * loop should proceed into PLANNING, or `{ ready: false }` when the task
   * has been left WAITING (dependency not yet COMPLETED) — or failed, if
   * the dependency itself already ended terminally without COMPLETEing,
   * since it can then never resolve.
   */
  private resolveDependencyGate(task: AgentTaskRecord): { ready: boolean; task: AgentTaskRecord } {
    if (!task.dependsOnTaskId) return { ready: true, task };
    const dep = this.deps.taskStore.get(task.dependsOnTaskId);
    if (dep?.state === "COMPLETED") return { ready: true, task };

    let waiting = task;
    if (waiting.state !== "WAITING") {
      waiting = this.emitTransition(waiting, "WAITING", `waiting on dependency task ${task.dependsOnTaskId}`);
    }
    if (dep && isTerminalState(dep.state)) {
      const withReason = this.deps.taskStore.setFailureReason(
        waiting.id,
        `Dependency task ${task.dependsOnTaskId} ended in ${dep.state}, not COMPLETED — this task can never proceed`
      );
      waiting = this.emitTransition(withReason, "FAILED", `dependency ended in ${dep.state}`);
    }
    return { ready: false, task: waiting };
  }

  private async runTaskLoop(taskId: string, startedAtMs: number): Promise<AgentTaskRecord> {
    const { maxTotalSteps, maxStepRetries, maxRecoveryCycles, stepTimeoutMs, taskTimeoutMs } = this.options;
    let task = this.deps.taskStore.requireOrThrow(taskId);

    if (task.state === "PENDING" || task.state === "WAITING") {
      const gate = this.resolveDependencyGate(task);
      task = gate.task;
      if (!gate.ready) {
        return this.deps.taskStore.requireOrThrow(taskId);
      }
      task = this.emitTransition(task, "PLANNING", task.state === "WAITING" ? "dependency resolved; resuming" : "task started");
    }

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
