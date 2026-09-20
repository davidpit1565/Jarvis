import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { AlarmStore } from "@/alarms/AlarmStore";

export interface DeleteAlarmInput extends Record<string, unknown> {
  id: string;
}

/** Cancels a scheduled alarm by its id. SAFE_ACTION and standing-granted, same reasoning as delete_reminder. */
export function createDeleteAlarmTool(alarmStore: AlarmStore): LocalTool<DeleteAlarmInput> {
  return {
    id: "DELETE_ALARM",
    name: "delete_alarm",
    description: "Cancels a scheduled alarm by its id (from a prior create_alarm or list_alarms call).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The id of the alarm to cancel." },
      },
      required: ["id"],
    },
    requiredPermission: PermissionLevel.SAFE_ACTION,
    target: "local",

    async execute(input) {
      if (typeof input.id !== "string" || input.id.trim() === "") {
        return { success: false, error: "id must be a non-empty string" };
      }

      const deleted = alarmStore.delete(input.id);
      if (!deleted) {
        return { success: false, error: `No alarm found with id: ${input.id}` };
      }
      return { success: true, data: { id: input.id } };
    },
  };
}
