import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { ReminderStore } from "@/reminders/ReminderStore";

export interface ListRemindersInput extends Record<string, unknown> {
  includeCompleted?: boolean;
}

/**
 * Lets Claude answer "what do I need to do" / "what's on my list" with the
 * user's actual pending reminders, not a guess. READ-level: this only ever
 * reads state, never changes it.
 */
export function createListRemindersTool(reminderStore: ReminderStore): LocalTool<ListRemindersInput> {
  return {
    id: "LIST_REMINDERS",
    name: "list_reminders",
    description:
      "Lists the user's reminders/tasks, soonest-due first, undated ones last. By default only pending " +
      "(not yet completed) ones are returned; pass includeCompleted=true to also see completed ones.",
    inputSchema: {
      type: "object",
      properties: {
        includeCompleted: { type: "boolean", description: "Include already-completed reminders. Defaults to false." },
      },
    },
    requiredPermission: PermissionLevel.READ,
    target: "local",

    async execute(input) {
      const includeCompleted = input.includeCompleted === true;
      const reminders = reminderStore.list(includeCompleted);
      return { success: true, data: { reminders } };
    },
  };
}
