import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { AgentCore } from "@/agent/AgentCore";
import type { GoalStore } from "@/agent/GoalStore";

export interface CreateGoalInput extends Record<string, unknown> {
  description: string;
  steps: string[];
}

const MIN_STEPS = 1;
// Both `description` and each `step` are free text the model writes from
// the user's own words, and both get re-inserted verbatim into a future
// conversation's system prompt via `goalProgressNote.ts` — potentially
// every conversation until the goal is explicitly completed/abandoned.
// Without a cap, an absurdly long description or step (whether from a
// confused model call or adversarial text the user was tricked into
// pasting) would sit in that prompt forever, wasting context on every
// future turn. These limits are generous for a real goal/step (a
// sentence or two) while still bounding the worst case.
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_STEP_LENGTH = 300;
// A hard ceiling on how many steps a single CREATE_GOAL call may create.
// This is the concrete guard against the AutoGPT/BabyAGI-style failure
// mode (a model recursively expanding a goal into an ever-growing,
// increasingly incoherent task list): decomposition happens exactly once,
// by the model, from the user's own statement, into a small flat list —
// never recursively, never re-planned mid-flight by JARVIS itself. A goal
// that genuinely needs more than this many steps should be split into
// multiple CREATE_GOAL calls (or the user re-engaged) rather than letting
// one call spawn an unbounded plan.
const MAX_STEPS = 12;

/**
 * Lets Claude create a Goal (roadmap items 26-27) from an explicit user
 * statement — "help me launch my project" — broken into a flat, concrete
 * list of steps. This is deliberately the ONLY place goal decomposition
 * happens: `steps` must be provided by the model right here, up front,
 * from what the user actually said; nothing downstream (AgentCore,
 * BrainAgentPlanner, a future tick) is ever allowed to add, remove, or
 * re-decompose steps on its own. That's what keeps this from becoming the
 * well-documented AutoGPT/BabyAGI runaway-task-list failure mode: a goal
 * here is a fixed, user-anchored checklist, not an open-ended planning
 * loop that reprioritizes or spawns subtasks unsupervised.
 *
 * Each step becomes its own AgentTask (`AgentCore.startGoal`), sharing one
 * goalId, and runs through the exact same Orchestrator/PermissionService/
 * ConfirmationService pipeline as any other tool call — CONFIRM/DANGEROUS
 * steps still require real per-invocation human approval; this tool only
 * ever enqueues work, it never bypasses that gate. SAFE_ACTION (not
 * CONFIRM) for the same single-user reasoning as CREATE_REMINDER/
 * CREATE_COMMITMENT: creating a goal/task list is itself inert — nothing
 * irreversible happens until an individual step actually runs, and that
 * step's own permission level is what gates it.
 */
export function createCreateGoalTool(goalStore: GoalStore, agentCore: AgentCore): LocalTool<CreateGoalInput> {
  return {
    id: "CREATE_GOAL",
    name: "create_goal",
    description:
      "Creates a tracked, multi-step Goal from something the user explicitly asked for " +
      '(e.g. "help me launch my project" or "I want to get my app ready for the App Store"). ' +
      "Only call this from a real, explicit user statement of what they want achieved — never invent a " +
      'goal unprompted. Break it into a short, concrete, FLAT list of "steps" yourself, anchored to what ' +
      "the user actually said (do not recursively expand steps into further sub-steps, and do not create " +
      `more than ${MAX_STEPS} steps — if it genuinely needs more, ask the user or split it into a second ` +
      "goal later). JARVIS will track and work through these steps across this and future conversations, " +
      "and can report progress with check_goal_progress without the user needing to re-explain.",
    inputSchema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "The user's own goal, in plain text, close to how they said it.",
        },
        steps: {
          type: "array",
          items: { type: "string" },
          description: `A flat, ordered list of concrete steps (1-${MAX_STEPS}) that together achieve the goal.`,
        },
      },
      required: ["description", "steps"],
    },
    requiredPermission: PermissionLevel.SAFE_ACTION,
    target: "local",

    async execute(input, context) {
      if (typeof input.description !== "string" || input.description.trim() === "") {
        return { success: false, error: "description must be a non-empty string" };
      }
      if (input.description.length > MAX_DESCRIPTION_LENGTH) {
        return { success: false, error: `description must not exceed ${MAX_DESCRIPTION_LENGTH} characters` };
      }
      if (!Array.isArray(input.steps) || input.steps.some((step) => typeof step !== "string" || step.trim() === "")) {
        return { success: false, error: "steps must be an array of non-empty strings" };
      }
      if (input.steps.some((step) => step.length > MAX_STEP_LENGTH)) {
        return { success: false, error: `each step must not exceed ${MAX_STEP_LENGTH} characters` };
      }
      if (input.steps.length < MIN_STEPS) {
        return { success: false, error: "steps must contain at least one step" };
      }
      if (input.steps.length > MAX_STEPS) {
        return {
          success: false,
          error: `steps must not exceed ${MAX_STEPS} — split this into multiple goals instead of one large plan`,
        };
      }

      const { goalId, tasks } = agentCore.startGoal(context.userId, input.steps);
      const goal = goalStore.createWithId(goalId, { userId: context.userId, description: input.description });

      return {
        success: true,
        data: {
          goalId: goal.id,
          description: goal.description,
          status: goal.status,
          steps: tasks.map((task) => ({ taskId: task.id, step: task.goal, state: task.state })),
        },
      };
    },
  };
}
