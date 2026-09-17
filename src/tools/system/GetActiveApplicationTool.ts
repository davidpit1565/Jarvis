import { PermissionLevel } from "@/types/permissions";
import type { DeviceTool } from "@/types/tools";

/**
 * The first device-executed tool. Runs only on a device agent (the iMac
 * first) — Core has no local implementation of this and never inspects
 * "the active application" itself. Read-only: reports the frontmost
 * application's name and bundle identifier, nothing about window
 * contents, and does not require Accessibility permission on macOS since
 * NSWorkspace.frontmostApplication is available without it.
 */
export const getActiveApplicationTool: DeviceTool = {
  id: "GET_ACTIVE_APPLICATION",
  name: "get_active_application",
  description:
    "Returns the name and bundle identifier of the currently active (frontmost) application on the " +
    "target device. Read-only: does not read window contents, control the application, or require " +
    "Accessibility permission.",
  inputSchema: {
    type: "object",
    properties: {
      deviceId: {
        type: "string",
        description: "Device to query. Defaults to the primary device if omitted.",
      },
    },
  },
  requiredPermission: PermissionLevel.READ,
  target: "device",
};

/** Shape of a successful GET_ACTIVE_APPLICATION result, produced by the iMac Agent. */
export interface ActiveApplicationInfo {
  application: string;
  bundleId: string;
}
