import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { AgentCore } from "@/agent/AgentCore";
import type { AgentTaskStore } from "@/agent/AgentTaskStore";
import type { GoalStore } from "@/agent/GoalStore";

export interface CancelGoalInput extends Record<string, unknown> {
  goalId: string;
}

/**
 * Lets Claude drop a goal the user no longer wants ("never mind that",
 * "forget about launching that for now") — marks the goal record
 * "abandoned" and cooperatively cancels every one of its still-running
 * AgentTasks via `AgentCore.cancel` (the same cancellation path
 * `cancelActiveTasksForUser`/`Orchestrator.requestStop` already use: a
 * task stops at its next checkpoint, never mid-tool-call). A task already
 * terminal (COMPLETED/FAILED/CANCELLED) is left as-is — cancelling only
 * ever affects work still in flight.
 *
 * A PENDING or WAITING task — queued but not yet picked up by
 * `AgentCore.runQueueTick` — is transitioned straight to CANCELLED in
 * `AgentTaskStore` right here, rather than relying only on `AgentCore
 * .cancel`'s in-memory `cancelled` Set. That Set is intentionally not
 * persisted (see its own doc comment: cancellation only needs to matter
 * while a task's loop can still check it), so a PENDING task that hasn't
 * started its loop yet would survive a process restart untouched — still
 * PENDING in the database — and `getNextEligibleQueuedTask` would hand it
 * straight back to the queue after restart, executing a step of a goal the
 * user explicitly abandoned. Mutating the store directly is safe here
 * specifically because these tasks have no loop actively running against
 * them yet (nothing to race with); a task already PLANNING/EXECUTING/
 * VERIFYING/RETRYING/RECOVERING still only gets the cooperative in-memory
 * cancel, exactly as before, since stopping those immediately from outside
 * their own loop could race with that loop's own writes.
 */
export function createCancelGoalTool(goalStore: GoalStore, agentCore: AgentCore, taskStore: AgentTaskStore): LocalTool<CancelGoalInput> {
  return {
    id: "CANCEL_GOAL",
    name: "cancel_goal",
    description:
      'Abandons a tracked goal the user no longer wants pursued, and stops any of its steps still in ' +
      'progress. Pass the goal\'s "goalId" (from create_goal or check_goal_progress).',
    inputSchema: {
      type: "object",
      properties: {
        goalId: { type: "string", description: "The goal's id." },
      },
      required: ["goalId"],
    },
    requiredPermission: PermissionLevel.SAFE_ACTION,
    target: "local",

    async execute(input, context) {
      if (typeof input.goalId !== "string" || input.goalId.trim() === "") {
        return { success: false, error: "goalId must be a non-empty string" };
      }
      const goal = goalStore.get(input.goalId);
      if (!goal || goal.userId !== context.userId) {
        return { success: false, error: `No goal found with id "${input.goalId}"` };
      }

      const tasks = taskStore.listForGoal(input.goalId);
      const cancelledTaskIds: string[] = [];
      for (const task of tasks) {
        if (task.state === "COMPLETED" || task.state === "FAILED" || task.state === "CANCELLED") {
          continue;
        }
        if (task.state === "PENDING" || task.state === "WAITING") {
          // Not yet in flight — cancel it durably now rather than only in
          // AgentCore's in-memory Set (see doc comment above).
          taskStore.setState(task.id, "CANCELLED");
        } else {
          // Already running (PLANNING/EXECUTING/VERIFYING/RETRYING/
          // RECOVERING) — stop it cooperatively at its next checkpoint,
          // never mid-tool-call.
          agentCore.cancel(task.id);
        }
        cancelledTaskIds.push(task.id);
      }

      const updated = goalStore.abandon(input.goalId);
      return {
        success: true,
        data: { goalId: updated.id, status: updated.status, closedAt: updated.closedAt, cancelledTaskIds },
      };
    },
  };
}
