import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import { isValidTimeOfDay, WakeUpCallStore } from "@/wakeup/WakeUpCallStore";

export interface CreateWakeUpCallInput extends Record<string, unknown> {
  timeOfDay: string;
  label?: string;
}

/**
 * Lets the user set up a recurring wake-up/scheduled call just by asking
 * ("wake me up at 7am every day") instead of needing a separate app or
 * config edit. JARVIS itself calls the user's phone at this time every
 * day until the call is deleted — see WakeUpCallStore and the scheduler in
 * index.ts that actually places the call. SAFE_ACTION and standing-granted
 * like create_reminder: creating a schedule entry isn't itself dangerous,
 * only actually placing calls costs money, which happens later and is
 * capped by the schedule the user themselves set.
 */
export function createCreateWakeUpCallTool(wakeUpCallStore: WakeUpCallStore): LocalTool<CreateWakeUpCallInput> {
  return {
    id: "CREATE_WAKEUP_CALL",
    name: "create_wakeup_call",
    description:
      "Schedules a recurring daily phone call from JARVIS at the given time — e.g. a wake-up call instead of " +
      'an alarm clock. Use this when the user asks to be called/woken up at a specific time. "timeOfDay" must ' +
      'be 24-hour "HH:MM" in the user\'s own local timezone (resolve "7am" to "07:00" yourself). The call ' +
      "repeats every day until deleted.",
    inputSchema: {
      type: "object",
      properties: {
        timeOfDay: { type: "string", description: '24-hour "HH:MM", e.g. "07:00".' },
        label: { type: "string", description: 'Optional short description, e.g. "weekday wake-up".' },
      },
      required: ["timeOfDay"],
    },
    requiredPermission: PermissionLevel.SAFE_ACTION,
    target: "local",

    async execute(input) {
      if (typeof input.timeOfDay !== "string" || !isValidTimeOfDay(input.timeOfDay)) {
        return { success: false, error: 'timeOfDay must be 24-hour "HH:MM", e.g. "07:00"' };
      }
      if (input.label !== undefined && typeof input.label !== "string") {
        return { success: false, error: "label must be a string" };
      }

      const record = wakeUpCallStore.create({ timeOfDay: input.timeOfDay, label: input.label ?? null });
      return { success: true, data: { id: record.id, timeOfDay: record.timeOfDay, label: record.label } };
    },
  };
}
