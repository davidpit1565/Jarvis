import { PermissionLevel } from "@/types/permissions";
import type { DeviceTool } from "@/types/tools";
import type { UserMessageImage } from "@/types/conversation";

/** The registered tool `name` — exported so Orchestrator's vision bridge (see `screenVisionBridge.ts`) can match on it without a duplicated magic string. */
export const LOOK_AT_SCREEN_TOOL_NAME = "look_at_screen";

/** The media types a LOOK_AT_SCREEN result is allowed to claim — kept in sync with `UserMessageImage["mediaType"]`. */
const ALLOWED_MEDIA_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** A successful LOOK_AT_SCREEN device result's `data` shape. */
export interface LookAtScreenImageData {
  mediaType: UserMessageImage["mediaType"];
  data: string;
  sizeBytes?: number;
}

/**
 * Type guard for a device's raw `ToolResult.data` — defense in depth before
 * the Orchestrator's vision bridge trusts it enough to attach as a real
 * `UserMessageImage` (see `screenVisionBridge.extractScreenVisionImage`).
 * Never assumes the device agent's own output is already well-formed.
 */
export function isLookAtScreenImageData(value: unknown): value is LookAtScreenImageData {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.mediaType === "string" &&
    ALLOWED_MEDIA_TYPES.has(candidate.mediaType) &&
    typeof candidate.data === "string" &&
    candidate.data.length > 0
  );
}

/**
 * Captures a screenshot of the target device's screen and returns the
 * actual image bytes (downscaled/recompressed on the device side to fit
 * JARVIS's image size cap) — NOT a file path. This is deliberately a
 * sibling of CAPTURE_SCREENSHOT, not a replacement or an extension of it:
 * CAPTURE_SCREENSHOT exists for "save a screenshot and send it to my
 * phone" (path-only, composes with READ_FILE_BYTES + SHARE_FILE_TO_PHONE
 * — see its own doc comment), while this tool exists for "let the model
 * actually see what's on screen right now and comment on specifics." The
 * Orchestrator's vision bridge (`screenVisionBridge.ts`) special-cases a
 * successful call to THIS tool (by `LOOK_AT_SCREEN_TOOL_NAME`) to attach
 * the returned image as a real `UserMessageImage` on the model's very
 * next brain call within the same turn — see that file's doc comment for
 * exactly how and why, including why the raw bytes are never persisted
 * into long-term conversation history.
 *
 * CONFIRM, same tier and reasoning as CAPTURE_SCREENSHOT: it can see
 * whatever is currently visible on David's screen, so PermissionService
 * forces a fresh confirmation on every call.
 */
export const lookAtScreenTool: DeviceTool = {
  id: "LOOK_AT_SCREEN",
  name: LOOK_AT_SCREEN_TOOL_NAME,
  description:
    "Captures a screenshot of the target device's screen right now and lets you genuinely see it on your very " +
    "next reasoning step — unlike capture_screenshot (which only saves a file and returns a path), this tool " +
    "gives you the actual image so you can comment on real specifics (what's visible, what a button says, which " +
    "of two things on screen looks better). Use this when the user asks you to look at their screen, or asks a " +
    "question that implicitly needs to see what's currently displayed (e.g. 'which of these looks better', " +
    "'what should I do here', 'is the one on the right good'). Requires the device to have granted Screen " +
    "Recording permission to the Jarvis agent at least once.",
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
