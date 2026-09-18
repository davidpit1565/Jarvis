import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { ReminderStore } from "@/reminders/ReminderStore";

export interface DeleteReminderInput extends Record<string, unknown> {
  id: string;
}

/**
 * True delete — distinct from COMPLETE_REMINDER: for a reminder that
 * should never have existed (created by mistake, or no longer relevant)
 * rather than one that was actually done. Without this, the only way to
 * get rid of a bad reminder was to mark it "completed", which is
 * misleading in list_reminders(includeCompleted: true) history.
 */
export function createDeleteReminderTool(reminderStore: ReminderStore): LocalTool<DeleteReminderInput> {
  return {
    id: "DELETE_REMINDER",
    name: "delete_reminder",
    description:
      "Permanently deletes a reminder/task by id (from a prior list_reminders or create_reminder call). " +
      "Use this when a reminder was created by mistake or is no longer relevant — not for one the user " +
      "actually did, which should use complete_reminder instead.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The reminder's id." },
      },
      required: ["id"],
    },
    requiredPermission: PermissionLevel.SAFE_ACTION,
    target: "local",

    async execute(input) {
      if (typeof input.id !== "string" || input.id.trim() === "") {
        return { success: false, error: "id must be a non-empty string" };
      }

      const deleted = reminderStore.delete(input.id);
      if (!deleted) {
        return { success: false, error: `No reminder found with id: ${input.id}` };
      }
      return { success: true, data: { id: input.id } };
    },
  };
}
