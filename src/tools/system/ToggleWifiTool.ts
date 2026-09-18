import { PermissionLevel } from "@/types/permissions";
import type { DeviceTool } from "@/types/tools";

/**
 * Turns the target device's Wi-Fi radio on or off. SAFE_ACTION: reversible
 * (toggle it back), and the Agent's own implementation calls CoreWLAN's
 * public API directly — never a shell command or AppleScript.
 */
export const toggleWifiTool: DeviceTool = {
  id: "TOGGLE_WIFI",
  name: "toggle_wifi",
  description: "Turns Wi-Fi on or off on the target device.",
  inputSchema: {
    type: "object",
    properties: {
      enabled: { type: "boolean", description: "true to turn Wi-Fi on, false to turn it off." },
      deviceId: {
        type: "string",
        description: "Device to toggle Wi-Fi on. Defaults to the primary device if omitted.",
      },
    },
    required: ["enabled"],
  },
  requiredPermission: PermissionLevel.SAFE_ACTION,
  target: "device",
  validateInput(input) {
    if (typeof input.enabled !== "boolean") {
      return { valid: false, reason: "enabled must be a boolean" };
    }
    return { valid: true };
  },
};
