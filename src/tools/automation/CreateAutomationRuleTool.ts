import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import { AutomationRuleStore } from "@/automation/AutomationRuleStore";
import { isValidTimeOfDay } from "@/wakeup/WakeUpCallStore";

export interface CreateAutomationRuleInput extends Record<string, unknown> {
  timeOfDay: string;
  instruction: string;
}

/**
 * Lets the user set up "JARVIS, do this on its own every day" — the
 * proactive-automation feature. At the scheduled time, JARVIS runs
 * `instruction` through the same Orchestrator/tool pipeline as any real
 * message (see getDueAutomationRules + the scheduler in index.ts), then
 * pushes the reply to the user. Every existing PermissionService/
 * ConfirmationService check still applies to whatever the instruction
 * does — this only automates *starting* a turn, never bypasses what that
 * turn is allowed to do. SAFE_ACTION and standing-granted like
 * create_reminder/create_wakeup_call: scheduling the rule itself isn't
 * dangerous, and whatever it actually does when it runs is gated the
 * normal way.
 */
export function createCreateAutomationRuleTool(automationRuleStore: AutomationRuleStore): LocalTool<CreateAutomationRuleInput> {
  return {
    id: "CREATE_AUTOMATION_RULE",
    name: "create_automation_rule",
    description:
      "Schedules JARVIS to act on its own every day at a given time — e.g. \"every morning at 8, check the " +
      'weather and text me if I need an umbrella\" or "every day at 9pm, tell me what\'s due tomorrow". ' +
      '"timeOfDay" must be 24-hour "HH:MM" in the user\'s own local timezone (resolve "8am" to "08:00" ' +
      'yourself). "instruction" is exactly what JARVIS should do when it fires, written as if the user typed ' +
      "it themselves. Repeats every day until deleted or disabled.",
    inputSchema: {
      type: "object",
      properties: {
        timeOfDay: { type: "string", description: '24-hour "HH:MM", e.g. "08:00".' },
        instruction: {
          type: "string",
          description: 'What JARVIS should do when this rule fires, e.g. "check the weather and tell me if I need an umbrella".',
        },
      },
      required: ["timeOfDay", "instruction"],
    },
    requiredPermission: PermissionLevel.SAFE_ACTION,
    target: "local",

    async execute(input) {
      if (typeof input.timeOfDay !== "string" || !isValidTimeOfDay(input.timeOfDay)) {
        return { success: false, error: 'timeOfDay must be 24-hour "HH:MM", e.g. "08:00"' };
      }
      if (typeof input.instruction !== "string" || input.instruction.trim().length === 0) {
        return { success: false, error: "instruction must be a non-empty string" };
      }

      try {
        const record = automationRuleStore.create({ timeOfDay: input.timeOfDay, instruction: input.instruction });
        return { success: true, data: { id: record.id, timeOfDay: record.timeOfDay, instruction: record.instruction } };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
