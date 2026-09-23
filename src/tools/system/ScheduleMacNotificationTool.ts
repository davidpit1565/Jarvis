import { PermissionLevel } from "@/types/permissions";
import type { DeviceTool } from "@/types/tools";

/**
 * Posts a real macOS system notification — "pop up a reminder on my
 * screen" — either immediately or after a delay. Distinct from
 * CREATE_ALARM (reaches the phone via Telegram) and CREATE_WAKEUP_CALL (a
 * real phone call): this one is Mac-local only. SAFE_ACTION: the effect
 * is fully specified (exact title/message/delay), same reasoning as
 * NOTIFY_USER — not open-ended like CLICK_ELEMENT/TYPE_TEXT.
 */
export const scheduleMacNotificationTool: DeviceTool = {
  id: "SCHEDULE_MAC_NOTIFICATION",
  name: "schedule_mac_notification",
  description:
    "Posts a real macOS system notification on the target device, either immediately (omit delaySeconds) or " +
    'after a delay (up to 24 hours — for daily recurrence use create_alarm instead). Use for "remind me on ' +
    'my screen in 10 minutes" or similar Mac-local nudges.',
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: 'Notification title. Defaults to "JARVIS" if omitted.' },
      message: { type: "string", description: "Notification body text." },
      delaySeconds: {
        type: "number",
        description: "Seconds to wait before showing it. Omit or 0 for immediately. Max 86400 (24 hours).",
      },
      deviceId: {
        type: "string",
        description: "Device to show the notification on. Defaults to the primary device if omitted.",
      },
    },
    required: ["message"],
  },
  requiredPermission: PermissionLevel.SAFE_ACTION,
  target: "device",
  validateInput(input) {
    if (typeof input.message !== "string" || input.message.trim().length === 0) {
      return { valid: false, reason: "message must be a non-empty string" };
    }
    if (input.delaySeconds !== undefined) {
      if (
        typeof input.delaySeconds !== "number" ||
        !Number.isFinite(input.delaySeconds) ||
        input.delaySeconds < 0 ||
        input.delaySeconds > 86400
      ) {
        return { valid: false, reason: "delaySeconds must be a number between 0 and 86400" };
      }
    }
    return { valid: true };
  },
};
