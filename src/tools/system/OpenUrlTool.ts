import { PermissionLevel } from "@/types/permissions";
import type { DeviceTool } from "@/types/tools";
import { validateUrl } from "./urlValidation";

/**
 * Opens a URL in the target device's default browser. SAFE_ACTION, not
 * CONFIRM/DANGEROUS: it only ever launches a browser window pointed at a
 * URL the user's own conversation asked for — same trust level as a
 * person clicking a link, reversible by just closing the tab, and never
 * reads or changes anything on the device itself. Deliberately not
 * "run this shell command" or "open this local file" — see
 * urlValidation.ts, which rejects every scheme except http/https before
 * this ever reaches a device.
 */
export const openUrlTool: DeviceTool = {
  id: "OPEN_URL",
  name: "open_url",
  description:
    "Opens a URL in the default web browser on the target device. Only http/https URLs are accepted — " +
    "this cannot open local files or any other URL scheme.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The http(s) URL to open." },
      deviceId: {
        type: "string",
        description: "Device to open the URL on. Defaults to the primary device if omitted.",
      },
    },
    required: ["url"],
  },
  requiredPermission: PermissionLevel.SAFE_ACTION,
  target: "device",
  validateInput(input) {
    return validateUrl(typeof input.url === "string" ? input.url : "");
  },
};
