import { PermissionLevel } from "@/types/permissions";
import type { DeviceTool } from "@/types/tools";

/**
 * Quits a named, already-running application on the target device — the
 * reverse of OPEN_APPLICATION. Runs only on a device agent; Core has no
 * local implementation. The Agent's own implementation only ever asks an
 * application NSWorkspace already knows is running to terminate via the
 * OS's public API, never an arbitrary process kill by PID/name.
 * SAFE_ACTION for the same reason as OPEN_APPLICATION: a real, visible
 * action, but reversible (the app can just be reopened) and low-impact.
 */
export const quitApplicationTool: DeviceTool = {
  id: "QUIT_APPLICATION",
  name: "quit_application",
  description:
    'Quits a named, currently running application on the target device (e.g. "Slack", "Spotify"). ' +
    "Use the application's actual display name. Fails if the application isn't currently running.",
  inputSchema: {
    type: "object",
    properties: {
      applicationName: {
        type: "string",
        description: 'The application\'s name, e.g. "Slack" or "Spotify".',
      },
      deviceId: {
        type: "string",
        description: "Device to quit the application on. Defaults to the primary device if omitted.",
      },
    },
    required: ["applicationName"],
  },
  requiredPermission: PermissionLevel.SAFE_ACTION,
  target: "device",
};
