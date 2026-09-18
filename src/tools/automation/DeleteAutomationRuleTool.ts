import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { AutomationRuleStore } from "@/automation/AutomationRuleStore";

export interface DeleteAutomationRuleInput extends Record<string, unknown> {
  id: string;
}

/**
 * Lets the user actually cancel an automation rule ("stop checking the
 * weather every morning") — without this, list_automation_rules could
 * show the schedule but nothing could remove an entry from it.
 * SAFE_ACTION and standing-granted like delete_wakeup_call.
 */
export function createDeleteAutomationRuleTool(automationRuleStore: AutomationRuleStore): LocalTool<DeleteAutomationRuleInput> {
  return {
    id: "DELETE_AUTOMATION_RULE",
    name: "delete_automation_rule",
    description: "Cancels a scheduled automation rule by its id (from a prior create_automation_rule or list_automation_rules call).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The id of the automation rule to cancel." },
      },
      required: ["id"],
    },
    requiredPermission: PermissionLevel.SAFE_ACTION,
    target: "local",

    async execute(input) {
      if (typeof input.id !== "string" || input.id.trim() === "") {
        return { success: false, error: "id must be a non-empty string" };
      }

      const deleted = automationRuleStore.delete(input.id);
      if (!deleted) {
        return { success: false, error: `No automation rule found with id: ${input.id}` };
      }
      return { success: true, data: { id: input.id } };
    },
  };
}
