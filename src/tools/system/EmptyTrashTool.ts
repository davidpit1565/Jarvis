import { PermissionLevel } from "@/types/permissions";
import type { DeviceTool } from "@/types/tools";

/**
 * Permanently deletes everything in the target device's Trash. CONFIRM:
 * irreversible once run, so PermissionService/ConfirmationService always
 * asks before it executes regardless of any standing grant.
 */
export const emptyTrashTool: DeviceTool = {
  id: "EMPTY_TRASH",
  name: "empty_trash",
  description: "Permanently empties the Trash on the target device.",
  inputSchema: {
    type: "object",
    properties: {
      deviceId: {
        type: "string",
        description: "Device to empty the Trash on. Defaults to the primary device if omitted.",
      },
    },
    required: [],
  },
  requiredPermission: PermissionLevel.CONFIRM,
  target: "device",
};
