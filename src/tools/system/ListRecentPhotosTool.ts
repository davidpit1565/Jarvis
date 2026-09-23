import { PermissionLevel } from "@/types/permissions";
import type { DeviceTool } from "@/types/tools";

/**
 * The first real Photos-library capability in this codebase — see
 * README.md's "A photo-library integration is a separate, larger piece
 * of work... intentionally not bundled into this change" for the prior
 * deferral this closes. Metadata only: filename, creation date,
 * dimensions, media type, favorite flag for the most recent N items —
 * never the image/video bytes themselves (that's real additional work,
 * still not bundled here). READ: no side effects, though the FIRST call
 * on a fresh Mac triggers a real macOS permission prompt and may need to
 * be retried once the user grants it (see ListRecentPhotosTool.swift).
 */
export const listRecentPhotosTool: DeviceTool = {
  id: "LIST_RECENT_PHOTOS",
  name: "list_recent_photos",
  description:
    "Lists the most recent photos/videos in the user's Photos library on the target device — filename, " +
    "creation date, dimensions, whether it's a video, and whether it's marked as a favorite. Metadata only, " +
    "never the actual image/video content. The very first call may need the user to grant a permission " +
    "prompt on their Mac first; if it fails, ask them to check for that and try again.",
  inputSchema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Maximum number of recent items to return. Defaults to 20, capped at 50.",
      },
      deviceId: {
        type: "string",
        description: "Device to list photos on. Defaults to the primary device if omitted.",
      },
    },
    required: [],
  },
  requiredPermission: PermissionLevel.READ,
  target: "device",
  validateInput(input) {
    if (input.limit !== undefined) {
      if (typeof input.limit !== "number" || !Number.isFinite(input.limit) || !Number.isInteger(input.limit)) {
        return { valid: false, reason: "limit must be an integer" };
      }
      if (input.limit < 1 || input.limit > 50) {
        return { valid: false, reason: "limit must be between 1 and 50" };
      }
    }
    return { valid: true };
  },
};
