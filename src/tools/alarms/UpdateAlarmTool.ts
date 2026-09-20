import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import { isValidTimeOfDay, AlarmStore } from "@/alarms/AlarmStore";

export interface UpdateAlarmInput extends Record<string, unknown> {
  id: string;
  timeOfDay?: string;
  label?: string | null;
  enabled?: boolean;
}

/**
 * Edits an existing alarm's time of day and/or label in place, or
 * pauses/resumes it — e.g. "actually wake me up at 8 instead" or "turn
 * off my alarm for now" without losing the schedule.
 */
export function createUpdateAlarmTool(alarmStore: AlarmStore): LocalTool<UpdateAlarmInput> {
  return {
    id: "UPDATE_ALARM",
    name: "update_alarm",
    description:
      "Edits an existing alarm's time of day, label, and/or enabled state, given its id (from a prior " +
      "create_alarm or list_alarms call). Omit a field to leave it unchanged.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The alarm's id." },
        timeOfDay: { type: "string", description: 'New 24-hour "HH:MM". Omit to leave unchanged.' },
        label: { type: "string", description: "New label. Omit to leave unchanged." },
        enabled: { type: "boolean", description: "Pause (false) or resume (true) this alarm. Omit to leave unchanged." },
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
        return { success: false, error: 'timeOfDay must be 24-hour "HH:MM", e.g. "07:00"' };
      }
      if (input.label !== undefined && input.label !== null && typeof input.label !== "string") {
        return { success: false, error: "label must be a string or null" };
      }
      if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
        return { success: false, error: "enabled must be a boolean" };
      }

      const updated = alarmStore.update(input.id, {
        timeOfDay: input.timeOfDay,
        label: input.label,
        enabled: input.enabled,
      });
      if (!updated) {
        return { success: false, error: `No alarm found with id: ${input.id}` };
      }
      return {
        success: true,
        data: { id: updated.id, timeOfDay: updated.timeOfDay, label: updated.label, enabled: updated.enabled },
      };
    },
  };
}
