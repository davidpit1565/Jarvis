import { PermissionLevel } from "@/types/permissions";
import type { DeviceTool } from "@/types/tools";

/**
 * Launches a named application on the target device — e.g. "open
 * WhatsApp." Runs only on a device agent; Core has no local
 * implementation. Deliberately NOT arbitrary shell/AppleScript execution:
 * the Agent's own implementation only ever asks the OS's public app-
 * launch API to open a known application by name, the same low-privilege
 * spirit as GET_ACTIVE_APPLICATION. SAFE_ACTION: opening an app is a real,
 * visible action (unlike a READ tool) but a fully reversible, low-impact
 * one — standing-granted per device once it's approved as primary (see
 * "device.roleGranted" wiring in index.ts), not asked about every time.
 */
export const openApplicationTool: DeviceTool = {
  id: "OPEN_APPLICATION",
  name: "open_application",
  description:
    "Opens/launches a named application on the target device (e.g. \"WhatsApp\", \"Google Chrome\"). " +
    "Use the application's actual display name. Does not close, control, or interact with the app beyond " +
    "launching it.",
  inputSchema: {
    type: "object",
    properties: {
      applicationName: {
        type: "string",
        description: 'The application\'s name, e.g. "WhatsApp" or "Safari".',
      },
      deviceId: {
        type: "string",
        description: "Device to open the application on. Defaults to the primary device if omitted.",
      },
    },
    required: ["applicationName"],
  },
  requiredPermission: PermissionLevel.SAFE_ACTION,
  target: "device",
};
