import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import { isValidTimeOfDay, AlarmStore } from "@/alarms/AlarmStore";

export interface CreateAlarmInput extends Record<string, unknown> {
  timeOfDay: string;
  label?: string;
}

/**
 * A real alarm clock — "wake me up at 7" without a phone call: fires a
 * Telegram push notification at the given time every day until deleted.
 * Distinct from create_wakeup_call (an actual phone call, costs Twilio
 * money per ring) — use this one whenever a phone call isn't specifically
 * what the user asked for. SAFE_ACTION and standing-granted like
 * create_reminder/create_wakeup_call: creating a schedule entry isn't
 * itself risky.
 */
export function createCreateAlarmTool(alarmStore: AlarmStore): LocalTool<CreateAlarmInput> {
  return {
    id: "CREATE_ALARM",
    name: "create_alarm",
    description:
      "Sets a recurring daily alarm — JARVIS sends a Telegram notification at the given time every day until " +
      'deleted. Use this for "set an alarm for X" / "wake me up at X" unless the user specifically wants an ' +
      'actual phone call (use create_wakeup_call for that instead). "timeOfDay" must be 24-hour "HH:MM" in ' +
      'the user\'s own local timezone (resolve "7am" to "07:00" yourself).',
    inputSchema: {
      type: "object",
      properties: {
        timeOfDay: { type: "string", description: '24-hour "HH:MM", e.g. "07:00".' },
        label: { type: "string", description: 'Optional short description, e.g. "gym alarm".' },
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

      const record = alarmStore.create({ timeOfDay: input.timeOfDay, label: input.label ?? null });
      return { success: true, data: { id: record.id, timeOfDay: record.timeOfDay, label: record.label } };
    },
  };
}
