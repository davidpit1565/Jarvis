import { PermissionLevel } from "@/types/permissions";
import type { DeviceTool } from "@/types/tools";

/**
 * Marks a reminder complete in the target device's real macOS Reminders
 * app (via EventKit), found by an exact title match. SAFE_ACTION:
 * reversible (uncheck it back in Reminders).
 */
export const completeMacReminderTool: DeviceTool = {
  id: "COMPLETE_MAC_REMINDER",
  name: "complete_mac_reminder",
  description: "Marks a reminder complete in the target device's real macOS Reminders app, found by its exact title.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "The exact title of the reminder to complete." },
      deviceId: {
        type: "string",
        description: "Device to complete the reminder on. Defaults to the primary device if omitted.",
      },
    },
    required: ["title"],
  },
  requiredPermission: PermissionLevel.SAFE_ACTION,
  target: "device",
  validateInput(input) {
    if (typeof input.title !== "string" || input.title.trim().length === 0) {
      return { valid: false, reason: "title must be a non-empty string" };
    }
    return { valid: true };
  },
};
