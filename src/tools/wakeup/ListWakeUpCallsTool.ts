import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { WakeUpCallStore } from "@/wakeup/WakeUpCallStore";

/**
 * Lets Claude answer "what wake-up calls do I have set" / "when am I being
 * called tomorrow" with the actual schedule instead of guessing. READ:
 * this only ever reads state.
 */
export function createListWakeUpCallsTool(wakeUpCallStore: WakeUpCallStore): LocalTool<Record<string, unknown>> {
  return {
    id: "LIST_WAKEUP_CALLS",
    name: "list_wakeup_calls",
    description: "Lists every scheduled recurring wake-up/phone call, with its time of day and whether it's enabled.",
    inputSchema: { type: "object", properties: {} },
    requiredPermission: PermissionLevel.READ,
    target: "local",

    async execute() {
      return { success: true, data: { calls: wakeUpCallStore.list() } };
    },
  };
}
