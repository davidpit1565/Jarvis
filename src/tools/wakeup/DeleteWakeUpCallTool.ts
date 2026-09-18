import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { WakeUpCallStore } from "@/wakeup/WakeUpCallStore";

export interface DeleteWakeUpCallInput extends Record<string, unknown> {
  id: string;
}

/**
 * Lets the user actually cancel a scheduled wake-up call ("stop calling me
 * at 7am") — without this, list_wakeup_calls could show the schedule but
 * nothing could remove an entry from it. SAFE_ACTION and standing-granted
 * like delete_reminder.
 */
export function createDeleteWakeUpCallTool(wakeUpCallStore: WakeUpCallStore): LocalTool<DeleteWakeUpCallInput> {
  return {
    id: "DELETE_WAKEUP_CALL",
    name: "delete_wakeup_call",
    description: "Cancels a scheduled wake-up/recurring call by its id (from a prior create_wakeup_call or list_wakeup_calls call).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The id of the wake-up call to cancel." },
      },
      required: ["id"],
    },
    requiredPermission: PermissionLevel.SAFE_ACTION,
    target: "local",

    async execute(input) {
      if (typeof input.id !== "string" || input.id.trim() === "") {
        return { success: false, error: "id must be a non-empty string" };
      }

      const deleted = wakeUpCallStore.delete(input.id);
      if (!deleted) {
        return { success: false, error: `No wake-up call found with id: ${input.id}` };
      }
      return { success: true, data: { id: input.id } };
    },
  };
}
