import { PermissionLevel } from "@/types/permissions";
import type { DeviceTool } from "@/types/tools";

/**
 * Reads ANY file (not just text — see READ_TEXT_FILE for that) on the
 * target device and returns it base64-encoded. The building block
 * share_file_to_phone (a local tool) uses to actually get a file's bytes
 * off the Mac before uploading it to Telegram — see that tool's doc
 * comment for why this is capped small (150KB): the result becomes part
 * of Claude's own context before it can be handed to the next tool call,
 * so this fits a small document or thumbnail, not a real photo or video.
 * Same allowlisted-folder restriction as READ_TEXT_FILE/LIST_DIRECTORY.
 * READ: no side effects.
 */
export const readFileBytesTool: DeviceTool = {
  id: "READ_FILE_BYTES",
  name: "read_file_bytes",
  description:
    "Reads any file (not just text) on the target device and returns its raw bytes, base64-encoded. Only " +
    "works within a small allowlist of user folders (Desktop, Documents, Downloads, Jarvis), and only for " +
    "files up to 150KB — this is meant for a small document, note, or thumbnail-sized image, not a real " +
    "photo or video. Use with share_file_to_phone to actually deliver the file to the user's phone.",
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
