import { PermissionLevel } from "@/types/permissions";
import type { DeviceTool } from "@/types/tools";

/**
 * Sets the target device's system output volume (0-100). SAFE_ACTION:
 * reversible (just say a different number, or mute), never touches
 * anything but audio output level. The Agent's own implementation calls
 * CoreAudio's public HAL API directly — never a shell command or
 * AppleScript.
 */
export const setVolumeTool: DeviceTool = {
  id: "SET_VOLUME",
  name: "set_volume",
  description: "Sets the system output volume on the target device, from 0 (silent) to 100 (maximum).",
  inputSchema: {
    type: "object",
    properties: {
      level: { type: "number", description: "Volume level, 0-100." },
      deviceId: {
        type: "string",
        description: "Device to set the volume on. Defaults to the primary device if omitted.",
      },
    },
    required: ["level"],
  },
  requiredPermission: PermissionLevel.SAFE_ACTION,
  target: "device",
  validateInput(input) {
    const level = input.level;
    if (typeof level !== "number" || !Number.isFinite(level)) {
      return { valid: false, reason: "level must be a number" };
    }
    if (level < 0 || level > 100) {
      return { valid: false, reason: "level must be between 0 and 100" };
    }
    return { valid: true };
  },
};
