import { PermissionLevel } from "@/types/permissions";
import type { DeviceTool } from "@/types/tools";

/**
 * Captures a full-screen screenshot on the target device and saves it as
 * a PNG under the device's "Jarvis" folder (one of FileAccessPolicy's
 * allowed roots), returning only the resulting path/filename/size — never
 * the image bytes themselves. To actually get the picture off the Mac,
 * follow up with READ_FILE_BYTES on the returned path, then
 * SHARE_FILE_TO_PHONE to deliver it — this tool deliberately doesn't do
 * all three steps itself; see CaptureScreenshotTool.swift's doc comment
 * for why a combined tool wasn't built. CONFIRM, not SAFE_ACTION/READ:
 * it can capture whatever is currently on David's screen (which may
 * include anything visible at that moment), so PermissionService forces
 * a fresh confirmation on every call, same tier as WRITE_FILE.
 */
export const captureScreenshotTool: DeviceTool = {
  id: "CAPTURE_SCREENSHOT",
  name: "capture_screenshot",
  description:
    "Captures a full-screen screenshot on the target device and saves it as a PNG under its Jarvis folder, " +
    "returning the path (not the image itself). Follow up with read_file_bytes on that path, then " +
    "share_file_to_phone, to actually send the picture to the user's phone. Requires the device to have " +
    "granted Screen Recording permission to the Jarvis agent at least once.",
  inputSchema: {
    type: "object",
    properties: {
      deviceId: {
        type: "string",
        description: "Device to capture the screen on. Defaults to the primary device if omitted.",
      },
    },
    required: [],
  },
  requiredPermission: PermissionLevel.CONFIRM,
  target: "device",
};
