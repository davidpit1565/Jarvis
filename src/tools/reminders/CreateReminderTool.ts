import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { ReminderStore } from "@/reminders/ReminderStore";

export interface CreateReminderInput extends Record<string, unknown> {
  text: string;
  dueAt?: string;
}

function isValidIsoDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

/**
 * Lets Claude create a reminder/task — the concrete mechanism behind "JARVIS,
 * remind me to..." A reminder is deliberately distinct from a memory: it has
 * a lifecycle (pending -> completed), not just a fact to recall. SAFE_ACTION
 * and standing-granted like SAVE_MEMORY, for the same single-user reason.
 */
export function createCreateReminderTool(reminderStore: ReminderStore): LocalTool<CreateReminderInput> {
  return {
    id: "CREATE_REMINDER",
    name: "create_reminder",
    description:
      "Creates a reminder or task for the user to see later. Use plain, specific text for what needs " +
      'to be done. If the user gave a specific time or date, pass it as an ISO 8601 timestamp in "dueAt" ' +
      "(e.g. from a phrase like \"remind me at 6pm\" or \"tomorrow morning\", resolve it to an actual " +
      'timestamp yourself); omit "dueAt" entirely for an undated task.',
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "What the reminder/task is, in plain text." },
        dueAt: { type: "string", description: "ISO 8601 timestamp this is due at. Omit for an undated task." },
      },
      required: ["text"],
    },
    requiredPermission: PermissionLevel.SAFE_ACTION,
    target: "local",

    async execute(input) {
      if (typeof input.text !== "string" || input.text.trim() === "") {
        return { success: false, error: "text must be a non-empty string" };
      }
      if (input.dueAt !== undefined) {
        if (typeof input.dueAt !== "string" || !isValidIsoDate(input.dueAt)) {
          return { success: false, error: "dueAt must be a valid ISO 8601 timestamp" };
        }
      }

      const record = reminderStore.create({ text: input.text, dueAt: input.dueAt ?? null });
      return { success: true, data: { id: record.id, text: record.text, dueAt: record.dueAt } };
    },
  };
}
