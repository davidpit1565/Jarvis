import { PermissionLevel } from "@/types/permissions";
import type { DeviceTool } from "@/types/tools";
import { validateDeviceRelativePath } from "./devicePathValidation";

/**
 * The first WRITE capability this Agent has ever had — every other file
 * tool (READ_TEXT_FILE, READ_FILE_BYTES, LIST_DIRECTORY) is read-only.
 * CONFIRM, not SAFE_ACTION: it can overwrite an existing file with no
 * undo, so PermissionService forces a fresh per-invocation human
 * confirmation on every single call regardless of any standing grant —
 * same treatment as CLICK_ELEMENT/TYPE_TEXT, and deliberately not in
 * STANDARD_PRIMARY_DEVICE_TOOLS's auto-grant list for that same reason.
 * Same allowlisted-folder restriction as the read tools.
 */
export const writeFileTool: DeviceTool = {
  id: "WRITE_FILE",
  name: "write_file",
  description:
    "Writes (creates or overwrites) a file on the target device, given base64-encoded content. Only works " +
    "within a small allowlist of user folders (Desktop, Documents, Downloads, Jarvis), and only up to 150KB. " +
    "Always confirm with the user exactly what will be written and to which path before calling this — it " +
    "can silently overwrite an existing file with no undo.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: 'File to write, relative to the home directory (e.g. "Desktop/notes.txt").',
      },
      base64Content: { type: "string", description: "Base64-encoded content to write." },
      deviceId: {
        type: "string",
        description: "Device to write the file on. Defaults to the primary device if omitted.",
      },
    },
    required: ["path", "base64Content"],
  },
  requiredPermission: PermissionLevel.CONFIRM,
  target: "device",
  validateInput(input) {
    return validateDeviceRelativePath(typeof input.path === "string" ? input.path : "");
  },
};
