import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { ReminderStore } from "@/reminders/ReminderStore";

export interface CompleteReminderInput extends Record<string, unknown> {
  id: string;
}

/**
 * Lets Claude mark a reminder/task done — "I already did that" should
 * actually remove it from the list, not just be acknowledged in text.
 * SAFE_ACTION and standing-granted for the same single-user reason as
 * CREATE_REMINDER.
 */
export function createCompleteReminderTool(reminderStore: ReminderStore): LocalTool<CompleteReminderInput> {
  return {
    id: "COMPLETE_REMINDER",
    name: "complete_reminder",
    description:
      "Marks a reminder/task as completed, given its id (from a prior list_reminders or create_reminder call).",
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

      const completed = reminderStore.complete(input.id);
      if (!completed) {
        return { success: false, error: `No reminder found with id: ${input.id}` };
      }
      return { success: true, data: { id: input.id } };
    },
  };
}
