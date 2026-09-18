import { PermissionLevel } from "@/types/permissions";
import type { DeviceTool } from "@/types/tools";
import { validateDeviceRelativePath } from "./devicePathValidation";

/**
 * Creates a new folder on the target device, restricted to the Agent's own
 * FileAccessPolicy allowlist (Desktop, Documents, Downloads, the Jarvis
 * folder). SAFE_ACTION: reversible (delete the folder), refuses to
 * overwrite anything that already exists.
 */
export const createFolderTool: DeviceTool = {
  id: "CREATE_FOLDER",
  name: "create_folder",
  description: "Creates a new folder on the target device, inside Desktop, Documents, Downloads, or the Jarvis folder.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path of the folder to create, e.g. 'Desktop/New Folder'." },
      deviceId: {
        type: "string",
        description: "Device to create the folder on. Defaults to the primary device if omitted.",
      },
    },
    required: ["path"],
  },
  requiredPermission: PermissionLevel.SAFE_ACTION,
  target: "device",
  validateInput(input) {
    return validateDeviceRelativePath(typeof input.path === "string" ? input.path : "");
  },
};
