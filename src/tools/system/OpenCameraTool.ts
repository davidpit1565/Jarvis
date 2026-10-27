import { PermissionLevel } from "@/types/permissions";
import type { DeviceTool } from "@/types/tools";

/**
 * Opens a live camera view on the target device — JARVIS's first real
 * camera capability anywhere in this codebase (2026-10-27, built alongside
 * the first native iPhone app, `ios/JarvisApp/`). Lets David ask things
 * like "does this fit me" / "what do you think of this, look at what the
 * camera sees right now" without manually taking and attaching a photo.
 *
 * CONFIRM, not SAFE_ACTION/READ: starting a live camera feed is at least
 * as privacy-sensitive as CAPTURE_SCREENSHOT (same tier), arguably more so
 * since it keeps capturing continuously rather than a single frame —
 * PermissionService forces a fresh confirmation on every call.
 *
 * Deliberately just "open the camera view" today, nothing more: this tool
 * does NOT itself return or analyze any image. A future "what do you see"
 * vision hookup (asking the device to capture and send a single frame for
 * Claude to look at, the same way LOOK_AT_SCREEN works for the Mac agent's
 * screen) is a natural next step but explicitly out of scope for this
 * first pass — see `CameraCloseTool.ts`'s sibling and the iOS app's
 * `Camera/CameraController.swift` for why the module is still shaped so
 * that hookup wouldn't need a rewrite.
 *
 * iPhone-only in practice today (the Mac agent has no camera tool and no
 * AVCaptureSession wiring), but left device-generic (no deviceType check)
 * the same way every other device tool here is — a device that doesn't
 * understand "open_camera" simply reports an unknown-tool error, exactly
 * like AgentToolRegistry.execute does for any tool name it doesn't
 * recognize.
 */
export const openCameraTool: DeviceTool = {
  id: "OPEN_CAMERA",
  name: "open_camera",
  description:
    "Opens a live camera view on the target device so the user can show JARVIS something in real time (e.g. " +
    "\"does this fit me\", \"what do you think of this\"). Requests camera permission at the moment this is " +
    "called if not already granted. This tool only opens the view — it does not capture or analyze an image " +
    "itself. Follow up with close_camera when the user is done, or when they ask to close it.",
  inputSchema: {
    type: "object",
    properties: {
      deviceId: {
        type: "string",
        description: "Device to open the camera on. Defaults to the primary device if omitted.",
      },
    },
    required: [],
  },
  requiredPermission: PermissionLevel.CONFIRM,
  target: "device",
};
