import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { AgentTaskStore } from "@/agent/AgentTaskStore";
import type { GoalStore } from "@/agent/GoalStore";
import type { GoalRecord } from "@/types/goals";

export interface CheckGoalProgressInput extends Record<string, unknown> {
  goalId?: string;
}

function summarizeGoal(goal: GoalRecord, taskStore: AgentTaskStore) {
  const progress = taskStore.getGoalProgress(goal.id);
  return {
    goalId: goal.id,
    description: goal.description,
    status: goal.status,
    createdAt: goal.createdAt,
    progress,
  };
}

/**
 * Lets Claude check on a Goal's progress (roadmap item 27) — either every
 * active goal for this user (no "goalId": the "what was I working on?"
 * case, also what surfaces proactively via `goalProgressNote` at the
 * start of a new conversation), or one goal's full step-by-step detail
 * when "goalId" is given. READ-only: this never changes anything, so it
 * carries no risk and needs no confirmation.
 */
export function createCheckGoalProgressTool(goalStore: GoalStore, taskStore: AgentTaskStore): LocalTool<CheckGoalProgressInput> {
  return {
    id: "CHECK_GOAL_PROGRESS",
    name: "check_goal_progress",
    description:
      "Reports progress on the user's tracked Goal(s). Omit \"goalId\" to list every active goal for the " +
      'user with its overall progress; pass a specific "goalId" (from create_goal\'s result, or from this ' +
      "tool's own list) to get that one goal's full step-by-step breakdown.",
    inputSchema: {
      type: "object",
      properties: {
        goalId: { type: "string", description: "A specific goal's id. Omit to list all active goals." },
      },
    },
    requiredPermission: PermissionLevel.READ,
    target: "local",

    async execute(input, context) {
      if (input.goalId !== undefined && (typeof input.goalId !== "string" || input.goalId.trim() === "")) {
        return { success: false, error: "goalId must be a non-empty string when provided" };
      }

      if (input.goalId === undefined) {
        const goals = goalStore.list(context.userId, "active");
        return { success: true, data: { goals: goals.map((goal) => summarizeGoal(goal, taskStore)) } };
      }

      const goal = goalStore.get(input.goalId);
      if (!goal) {
        return { success: false, error: `No goal found with id "${input.goalId}"` };
      }

      const tasks = taskStore.listForGoal(goal.id);
      return {
        success: true,
        data: {
          ...summarizeGoal(goal, taskStore),
          steps: tasks.map((task) => ({
            taskId: task.id,
            step: task.goal,
            state: task.state,
            failureReason: task.failureReason,
          })),
        },
      };
    },
  };
}
