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
        if (task.state !== "COMPLETED" && task.state !== "FAILED" && task.state !== "CANCELLED") {
          agentCore.cancel(task.id);
          cancelledTaskIds.push(task.id);
        }
      }

      const updated = goalStore.abandon(input.goalId);
      return {
        success: true,
        data: { goalId: updated.id, status: updated.status, closedAt: updated.closedAt, cancelledTaskIds },
      };
    },
  };
}
