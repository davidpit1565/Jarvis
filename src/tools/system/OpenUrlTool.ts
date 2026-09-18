import { PermissionLevel } from "@/types/permissions";
import type { DeviceTool } from "@/types/tools";

/**
 * Opens a URL in the target device's default browser — lets JARVIS act on
 * "open this on my computer" requests. Runs only on a device agent; Core
 * has no local implementation. The Agent's own implementation only
 * accepts http/https URLs via the OS's public open-URL API, never an
 * arbitrary URL scheme (some custom schemes trigger installed apps in
 * surprising ways, e.g. composing/sending something). SAFE_ACTION, same
 * reasoning as OPEN_APPLICATION: a real, visible action, but reversible
 * (just close the tab) and low-impact.
 */
export const openUrlTool: DeviceTool = {
  id: "OPEN_URL",
  name: "open_url",
  description:
    "Opens a URL in the default browser on the target device. Only http/https URLs are accepted. " +
    'Use this for "open this on my computer/Mac" requests.',
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The http/https URL to open." },
      deviceId: {
        type: "string",
        description: "Device to open the URL on. Defaults to the primary device if omitted.",
      },
    },
    required: ["url"],
  },
  requiredPermission: PermissionLevel.SAFE_ACTION,
  target: "device",
};
