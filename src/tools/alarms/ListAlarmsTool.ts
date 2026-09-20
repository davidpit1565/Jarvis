import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { AlarmStore } from "@/alarms/AlarmStore";

/** Lets Claude answer "what alarms do I have set" with the actual schedule. READ-only. */
export function createListAlarmsTool(alarmStore: AlarmStore): LocalTool<Record<string, unknown>> {
  return {
    id: "LIST_ALARMS",
    name: "list_alarms",
    description: "Lists every scheduled recurring alarm, with its time of day and whether it's enabled.",
    inputSchema: { type: "object", properties: {} },
    requiredPermission: PermissionLevel.READ,
    target: "local",

    async execute() {
      return { success: true, data: { alarms: alarmStore.list() } };
    },
  };
}
