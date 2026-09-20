import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { AutomationRuleStore } from "@/automation/AutomationRuleStore";

/**
 * Lets Claude answer "what automations do I have running" with the
 * actual schedule instead of guessing. READ: this only ever reads state.
 */
export function createListAutomationRulesTool(automationRuleStore: AutomationRuleStore): LocalTool<Record<string, unknown>> {
  return {
    id: "LIST_AUTOMATION_RULES",
    name: "list_automation_rules",
    description: "Lists every scheduled automation rule, with its time of day, instruction, and whether it's enabled.",
    inputSchema: { type: "object", properties: {} },
    requiredPermission: PermissionLevel.READ,
    target: "local",

    async execute() {
      return { success: true, data: { rules: automationRuleStore.list() } };
    },
  };
}
