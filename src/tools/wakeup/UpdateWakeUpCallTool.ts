import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import { isValidTimeOfDay, WakeUpCallStore } from "@/wakeup/WakeUpCallStore";

export interface UpdateWakeUpCallInput extends Record<string, unknown> {
  id: string;
  timeOfDay?: string;
  label?: string | null;
}

/**
 * Edits an existing wake-up call's time of day and/or label in place —
 * e.g. "actually wake me up at 8 instead of 7". Without this, the only
 * way to change a wake-up time was delete-then-recreate, which loses
 * lastTriggeredDate for no reason (so the call could re-fire again today
 * right after being "changed" for a later time today).
 */
export function createUpdateWakeUpCallTool(wakeUpCallStore: WakeUpCallStore): LocalTool<UpdateWakeUpCallInput> {
  return {
    id: "UPDATE_WAKEUP_CALL",
    name: "update_wakeup_call",
    description:
      "Edits an existing scheduled wake-up/recurring call's time of day and/or label, given its id (from a " +
      'prior create_wakeup_call or list_wakeup_calls call). Omit a field to leave it unchanged. Use this for ' +
      '"actually wake me up at 8 instead" rather than deleting and recreating it.',
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The wake-up call's id." },
        timeOfDay: { type: "string", description: 'New 24-hour "HH:MM". Omit to leave unchanged.' },
        label: { type: "string", description: "New label. Omit to leave unchanged." },
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

      const updated = wakeUpCallStore.update(input.id, { timeOfDay: input.timeOfDay, label: input.label });
      if (!updated) {
        return { success: false, error: `No wake-up call found with id: ${input.id}` };
      }
      return { success: true, data: { id: updated.id, timeOfDay: updated.timeOfDay, label: updated.label } };
    },
  };
}
