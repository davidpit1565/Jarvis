import { PermissionLevel } from "@/types/permissions";
import type { DeviceTool } from "@/types/tools";

/**
 * Closes a camera view previously opened by OPEN_CAMERA. SAFE_ACTION (not
 * CONFIRM): tearing down a capture session is the privacy-reducing
 * direction — same reasoning QUIT_APPLICATION already uses relative to
 * OPEN_APPLICATION's SAFE_ACTION tier (opening something is the one that
 * needs a beat of thought; closing it back down doesn't).
 *
 * See `OpenCameraTool.ts` for the full doc comment on this capability's
 * scope and iPhone-only reality today.
 */
export const closeCameraTool: DeviceTool = {
  id: "CLOSE_CAMERA",
  name: "close_camera",
  description:
    "Closes a previously opened live camera view on the target device, releasing the camera. Use this when " +
    "the user says they're done, or asks to close the camera.",
  inputSchema: {
    type: "object",
    properties: {
      deviceId: {
        type: "string",
        description: "Device to close the camera on. Defaults to the primary device if omitted.",
      },
    },
    required: [],
  },
  requiredPermission: PermissionLevel.SAFE_ACTION,
  target: "device",
};
