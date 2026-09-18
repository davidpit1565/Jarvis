import { PermissionLevel } from "@/types/permissions";
import type { DeviceTool } from "@/types/tools";

/**
 * Reads a text file's contents on the target device — e.g. "read that
 * notes file on my Desktop." Runs only on a device agent; Core has no
 * local implementation. Same allowlisted-folder restriction as
 * LIST_DIRECTORY, and text-only: binary files (photos, videos, etc.) are
 * rejected rather than dumped as base64, and the content is capped so a
 * huge file can't blow up context/cost. READ: no side effects.
 */
export const readTextFileTool: DeviceTool = {
  id: "READ_TEXT_FILE",
  name: "read_text_file",
  description:
    "Reads the text contents of a file on the target device. Only works within a small allowlist of user " +
    "folders (Desktop, Documents, Downloads, Jarvis), and only for text files — not photos, videos, or other " +
    "binaries. Large files are truncated.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: 'File to read, relative to the home directory (e.g. "Desktop/notes.txt").',
      },
      deviceId: {
        type: "string",
        description: "Device to read the file on. Defaults to the primary device if omitted.",
      },
    },
    required: ["path"],
  },
  requiredPermission: PermissionLevel.READ,
  target: "device",
};
