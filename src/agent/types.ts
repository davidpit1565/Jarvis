import type { ToolResult } from "@/types/tools";
import type { AgentTaskState } from "./AgentTaskStateMachine";

export type AgentStepStatus = "pending" | "in_progress" | "succeeded" | "failed" | "verified" | "verification_failed";

/** A single tool call in an agent task's plan, plus its own execution/verification lifecycle. */
export interface AgentPlanStep {
  id: string;
  description: string;
  toolName: string;
  input: Record<string, unknown>;
  status: AgentStepStatus;
  /** The most recent ToolResult this step produced, if it has run at least once. */
  lastResult?: ToolResult;
  /** Human-readable reason from the last verification attempt, if any. */
  verificationReason?: string;
}

/** A step the planner proposes — turned into a full AgentPlanStep once accepted onto a task. */
export interface AgentStepProposal {
  toolName: string;
  input: Record<string, unknown>;
  description: string;
}

export interface AgentTaskRecord {
  id: string;
  userId: string;
  goal: string;
  state: AgentTaskState;
  plan: AgentPlanStep[];
  currentStepIndex: number;
  /** Failed attempts of the *current* step since it was last (re)planned or advanced past. Reset when the step changes. */
  stepRetryCount: number;
  /** Number of PLANNING/RECOVERING replans this task has gone through. */
  recoveryCount: number;
  /** Total tool-call steps actually executed (including retries) — the hard cap this whole task obeys. */
  totalStepsExecuted: number;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  /**
   * Groups this task under a lightweight "Goal" (roadmap items 26-27) —
   * an opaque id shared by every AgentTask that decomposes the same goal.
   * There is no separate Goal row/table: a goal is just this shared id,
   * and its aggregate progress is computed on demand from the linked
   * tasks via `AgentTaskStore.getGoalProgress`. `null` for a standalone
   * task not part of any goal.
   */
  goalId: string | null;
  /**
   * Roadmap item 28 (Dependencies): this task will not leave PENDING/
   * WAITING for PLANNING until the task with this id has reached
   * COMPLETED. `null` for a task with no dependency. Kept deliberately
   * single-link (not a DAG) — chain multiple tasks for a longer sequence.
   */
  dependsOnTaskId: string | null;
  /**
   * Roadmap items 31-32 (Persistent + Priority Agent Queue): higher runs
   * first when `AgentCore.runQueueTick` picks the next eligible PENDING/
   * resolved-WAITING task. Defaults to 0; ties break oldest-first.
   */
  priority: number;
}

/** Request handed to an AgentPlanner to produce (or re-produce, after a failure) an ordered plan. */
export interface AgentPlanRequest {
  goal: string;
  userId: string;
  /** Set only on a RECOVERING replan: what went wrong with the previous attempt. */
  priorFailure?: string;
  /** Steps already completed and verified in a previous planning cycle, for context — never re-run automatically. */
  completedSteps: AgentPlanStep[];
  /**
   * This task's id — passed through to `Brain.chat()`/`AIRouter` as
   * `BrainRequest.runId`, scoping Denial-of-wallet protection
   * (`maxCostPerRunUsd`) to "one AgentCore task", same as
   * `Orchestrator.handleUserMessage` scopes it to "one turn". Optional:
   * a caller that omits it (e.g. a test stub) simply gets no per-run
   * cost ceiling applied to its `chat()` calls, same as any other
   * `BrainRequest` with no `runId`.
   */
  taskId?: string;
}

export interface AgentVerificationRequest {
  taskId?: string;
  step: AgentPlanStep;
  result: ToolResult;
  /**
   * Runs an additional tool call for verification purposes (e.g. a
   * follow-up list/get call) through the exact same Orchestrator pipeline
   * the original step ran through — a planner must never call a tool any
   * other way.
   */
  runVerificationTool: (toolName: string, input: Record<string, unknown>) => Promise<ToolResult>;
}

export interface AgentVerificationResult {
  verified: boolean;
  reason: string;
}

/**
 * Produces plans and verifies step results for the Autonomous Agent Core.
 * Kept as a narrow interface (not tied to `Brain` directly) so AgentCore is
 * testable with a scripted stub, while `BrainAgentPlanner` provides the
 * real, Brain-backed implementation used in production.
 */
export interface AgentPlanner {
  plan(request: AgentPlanRequest): Promise<AgentStepProposal[]>;
  verify(request: AgentVerificationRequest): Promise<AgentVerificationResult>;
}
