import { PermissionLevel } from "@/types/permissions";
import type { DeviceTool } from "@/types/tools";

/**
 * Lists the names of currently running, regular (user-visible) apps on
 * the target device — lets Claude answer "what's open on my Mac" or
 * check whether a specific app is already running before deciding to
 * open or quit it. Runs only on a device agent; Core has no local
 * implementation. Read-only: just app names, no window titles/contents,
 * and background-only helper processes are filtered out.
 */
export const listRunningApplicationsTool: DeviceTool = {
  id: "LIST_RUNNING_APPLICATIONS",
  name: "list_running_applications",
  description:
    "Lists the names of currently running, user-visible applications on the target device. Read-only: " +
    "does not read window contents or control any application.",
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

/** Shape of a successful LIST_RUNNING_APPLICATIONS result, produced by the iMac Agent. */
export interface RunningApplicationsInfo {
  applications: string[];
}
