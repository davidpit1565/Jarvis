import { PermissionLevel } from "@/types/permissions";
import type { DeviceTool } from "@/types/tools";

/**
 * Lists the entries of a directory on the target device — e.g. "what's
 * on my Desktop", "what's in my Downloads folder." Runs only on a
 * device agent; Core has no local implementation. The Agent's own
 * implementation (see agents/imac/.../Tools/ListDirectoryTool.swift)
 * only allows a short, explicit allowlist of folders (Desktop,
 * Documents, Downloads, a dedicated Jarvis folder) — never the whole
 * home directory or arbitrary paths. READ: purely informational, no
 * side effects.
 */
export const listDirectoryTool: DeviceTool = {
  id: "LIST_DIRECTORY",
  name: "list_directory",
  description:
    'Lists the files and folders inside a directory on the target device (e.g. "Desktop", "Downloads"). ' +
    "Only works within a small allowlist of user folders (Desktop, Documents, Downloads, Jarvis) — never " +
    "the whole computer.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: 'Folder to list, relative to the home directory (e.g. "Desktop" or "Documents/Work").',
      },
      deviceId: {
        type: "string",
        description: "Device to list the directory on. Defaults to the primary device if omitted.",
      },
    },
    required: ["path"],
  },
  requiredPermission: PermissionLevel.READ,
  target: "device",
};
