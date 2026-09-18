import { PermissionLevel } from "@/types/permissions";
import type { DeviceTool } from "@/types/tools";

/**
 * Creates a reminder in the target device's real macOS Reminders app (via
 * EventKit) — distinct from JARVIS's own SQLite-backed ReminderStore
 * (CREATE_REMINDER). Use this when the user wants it in their actual
 * Reminders app rather than JARVIS's own list. SAFE_ACTION: reversible
 * (delete it in Reminders, or COMPLETE_MAC_REMINDER).
 */
export const createMacReminderTool: DeviceTool = {
  id: "CREATE_MAC_REMINDER",
  name: "create_mac_reminder",
  description: "Creates a reminder in the target device's real macOS Reminders app (not JARVIS's own reminder list).",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "What the reminder is, in plain text." },
      dueAt: { type: "string", description: "ISO 8601 timestamp this is due at. Omit for an undated reminder." },
      deviceId: {
        type: "string",
        description: "Device to create the reminder on. Defaults to the primary device if omitted.",
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
    if (input.dueAt !== undefined) {
      if (typeof input.dueAt !== "string" || Number.isNaN(Date.parse(input.dueAt))) {
        return { valid: false, reason: "dueAt must be a valid ISO 8601 timestamp" };
      }
    }
    return { valid: true };
  },
};
