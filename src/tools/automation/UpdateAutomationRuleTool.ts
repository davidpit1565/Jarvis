import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { AutomationRuleStore } from "@/automation/AutomationRuleStore";
import { isValidTimeOfDay } from "@/wakeup/WakeUpCallStore";

export interface UpdateAutomationRuleInput extends Record<string, unknown> {
  id: string;
  timeOfDay?: string;
  instruction?: string;
  enabled?: boolean;
}

/**
 * Edits an existing automation rule's time of day, instruction, and/or
 * enabled state in place — e.g. "actually check the weather at 7 instead
 * of 8" or "pause my morning automations for now". Without this, the
 * only way to change a rule was delete-then-recreate, which loses
 * lastTriggeredDate for no reason (so the rule could re-fire again today
 * right after being "changed" for a later time today).
 */
export function createUpdateAutomationRuleTool(automationRuleStore: AutomationRuleStore): LocalTool<UpdateAutomationRuleInput> {
  return {
    id: "UPDATE_AUTOMATION_RULE",
    name: "update_automation_rule",
    description:
      "Edits an existing automation rule's time of day, instruction, and/or enabled state, given its id " +
      "(from a prior create_automation_rule or list_automation_rules call). Omit a field to leave it " +
      'unchanged. Use this for "actually do that at 7 instead" rather than deleting and recreating it, or to ' +
      'pause/resume it (e.g. "turn off my morning automation for now") without losing the schedule.',
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The automation rule's id." },
        timeOfDay: { type: "string", description: 'New 24-hour "HH:MM". Omit to leave unchanged.' },
        instruction: { type: "string", description: "New instruction. Omit to leave unchanged." },
        enabled: { type: "boolean", description: "Pause (false) or resume (true) this rule. Omit to leave unchanged." },
      },
      required: ["id"],
    },
    requiredPermission: PermissionLevel.SAFE_ACTION,
    target: "local",

    async execute(input) {
      if (typeof input.id !== "string" || input.id.trim() === "") {
        return { success: false, error: "id must be a non-empty string" };
      }
      if (input.timeOfDay !== undefined && (typeof input.timeOfDay !== "string" || !isValidTimeOfDay(input.timeOfDay))) {
        return { success: false, error: 'timeOfDay must be 24-hour "HH:MM", e.g. "08:00"' };
      }
      if (input.instruction !== undefined && (typeof input.instruction !== "string" || input.instruction.trim().length === 0)) {
        return { success: false, error: "instruction must be a non-empty string" };
      }
      if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
        return { success: false, error: "enabled must be a boolean" };
      }

      try {
        const updated = automationRuleStore.update(input.id, {
          timeOfDay: input.timeOfDay,
          instruction: input.instruction,
          enabled: input.enabled,
        });
        if (!updated) {
          return { success: false, error: `No automation rule found with id: ${input.id}` };
        }
        return {
          success: true,
          data: { id: updated.id, timeOfDay: updated.timeOfDay, instruction: updated.instruction, enabled: updated.enabled },
        };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
