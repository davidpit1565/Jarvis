import { PermissionLevel } from "@/types/permissions";
import type { DeviceTool } from "@/types/tools";

/**
 * Lists incomplete reminders from the target device's actual macOS
 * Reminders app (via EventKit) — distinct from JARVIS's own
 * SQLite-backed ReminderStore (LIST_REMINDERS). Use this when the user
 * means the real Reminders app (e.g. shared with Siri or synced across
 * their devices), not a JARVIS-only task. READ: purely informational.
 */
export const listMacRemindersTool: DeviceTool = {
  id: "LIST_MAC_REMINDERS",
  name: "list_mac_reminders",
  description: "Lists incomplete reminders from the target device's real macOS Reminders app (not JARVIS's own reminder list).",
  inputSchema: {
    type: "object",
    properties: {
      deviceId: {
        type: "string",
        description: "Device to list Reminders on. Defaults to the primary device if omitted.",
      },
    },
    required: [],
  },
  requiredPermission: PermissionLevel.READ,
  target: "device",
};
