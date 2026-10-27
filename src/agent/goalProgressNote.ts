import type { AgentTaskStore } from "@/agent/AgentTaskStore";
import type { GoalStore } from "@/agent/GoalStore";

/**
 * Formats a note about the user's active Goals for the system prompt, or
 * undefined when there are none — the "recall active goals at the start
 * of a new conversation" half of the Goal Engine (roadmap items 26-27),
 * same pattern as `dueRemindersNote`/`staleCommitmentsNote`: a standing
 * fact surfaced proactively, not something the user has to ask about
 * ("what was I working on?"). Reads `GoalStore` for what each goal *is*
 * and `AgentTaskStore.getGoalProgress` for how far along it is — neither
 * store needs to know about the other for this to work.
 */
export function goalProgressNote(goalStore: GoalStore, taskStore: AgentTaskStore, userId: string): string | undefined {
  const activeGoals = goalStore.list(userId, "active");
  if (activeGoals.length === 0) return undefined;

  const lines = activeGoals.map((goal) => {
    const progress = taskStore.getGoalProgress(goal.id);
    const nextStep = taskStore.listForGoal(goal.id).find((task) => task.state !== "COMPLETED" && task.state !== "FAILED" && task.state !== "CANCELLED");
    const progressText = progress.total > 0 ? `${progress.completed}/${progress.total} steps done` : "no steps yet";
    const nextText = nextStep ? `; next: ${nextStep.goal}` : "";
    return `- "${goal.description}" (${progressText}${nextText})`;
  });

  return (
    `The user has ${activeGoals.length} active goal(s) JARVIS is tracking across conversations — ` +
    `consider mentioning progress or the next step naturally if it fits, without being asked:\n${lines.join("\n")}`
  );
}
