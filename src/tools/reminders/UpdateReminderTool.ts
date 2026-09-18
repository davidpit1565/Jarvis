import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { ReminderStore } from "@/reminders/ReminderStore";

export interface UpdateReminderInput extends Record<string, unknown> {
  id: string;
  text?: string;
  dueAt?: string | null;
}

function isValidIsoDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

/**
 * Edits an existing reminder's text and/or due date in place — e.g.
 * "actually make that 7pm instead" or fixing a typo. Without this, the
 * only way to change anything about a reminder was delete-then-recreate,
 * which loses its original id and createdAt for no reason.
 */
export function createUpdateReminderTool(reminderStore: ReminderStore): LocalTool<UpdateReminderInput> {
  return {
    id: "UPDATE_REMINDER",
    name: "update_reminder",
    description:
      "Edits an existing reminder/task's text and/or due date, given its id. Omit a field to leave it " +
      'unchanged; pass dueAt as null to clear a due date (make it undated). Use this for "actually make ' +
      "that 7pm instead\" / \"change that reminder to...\" rather than deleting and recreating it.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The reminder's id." },
        text: { type: "string", description: "New text. Omit to leave unchanged." },
        dueAt: { type: "string", description: "New ISO 8601 due timestamp, or null to clear it. Omit to leave unchanged." },
      },
      required: ["id"],
    },
    requiredPermission: PermissionLevel.SAFE_ACTION,
    target: "local",

    async execute(input) {
      if (typeof input.id !== "string" || input.id.trim() === "") {
        return { success: false, error: "id must be a non-empty string" };
      }
      if (input.text !== undefined && (typeof input.text !== "string" || input.text.trim() === "")) {
        return { success: false, error: "text must be a non-empty string when provided" };
      }
      if (input.dueAt !== undefined && input.dueAt !== null) {
        if (typeof input.dueAt !== "string" || !isValidIsoDate(input.dueAt)) {
          return { success: false, error: "dueAt must be a valid ISO 8601 timestamp, or null" };
        }
      }

      const updated = reminderStore.update(input.id, { text: input.text, dueAt: input.dueAt });
      if (!updated) {
        return { success: false, error: `No reminder found with id: ${input.id}` };
      }
      return { success: true, data: { id: updated.id, text: updated.text, dueAt: updated.dueAt } };
    },
  };
}
