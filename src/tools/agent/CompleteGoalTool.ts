import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { GoalStore } from "@/agent/GoalStore";

export interface CompleteGoalInput extends Record<string, unknown> {
  goalId: string;
}

/**
 * Lets Claude mark a Goal done at the goal level — distinct from its
 * individual steps/AgentTasks reaching COMPLETED on their own. A goal can
 * be genuinely finished even when not every step auto-completed through a
 * tool (e.g. a step was "talk to a designer", which nothing in JARVIS can
 * verify for itself), or the user may simply say "that's done, thanks" —
 * either way, this is the explicit, human-anchored way a goal closes,
 * rather than JARVIS silently inferring completion from task states.
 * SAFE_ACTION, same reasoning as CREATE_GOAL: closing a goal record has no
 * real-world side effect of its own.
 */
export function createCompleteGoalTool(goalStore: GoalStore): LocalTool<CompleteGoalInput> {
  return {
    id: "COMPLETE_GOAL",
    name: "complete_goal",
    description:
      "Marks a tracked goal as completed — use when the user confirms a goal is done, or every step has " +
      'clearly been achieved. Pass the goal\'s "goalId" (from create_goal or check_goal_progress).',
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
      if (!goal) {
        return { success: false, error: `No goal found with id "${input.goalId}"` };
      }
      if (goal.userId !== context.userId) {
        return { success: false, error: `No goal found with id "${input.goalId}"` };
      }

      const updated = goalStore.complete(input.goalId);
      return { success: true, data: { goalId: updated.id, status: updated.status, closedAt: updated.closedAt } };
    },
  };
}
