import { PermissionLevel } from "@/types/permissions";
import type { DeviceTool } from "@/types/tools";
import { validateAppName } from "./appNameValidation";

/**
 * Launches a named application on the target device (macOS: via
 * NSWorkspace, matched by display name — see the Agent implementation).
 * SAFE_ACTION: it only ever launches something the user already has
 * installed, exactly as if they'd clicked its Dock/Launchpad icon
 * themselves — reversible (just quit it), and never reads or changes
 * anything inside the application. There is deliberately no "quit
 * application" or "force-close" counterpart yet — those are more
 * disruptive (an unsaved document, an in-progress call) and deserve their
 * own, separately-considered permission level rather than being bundled
 * in here as "the opposite of open."
 */
export const openApplicationTool: DeviceTool = {
  id: "OPEN_APPLICATION",
  name: "open_application",
  description:
    "Launches a named application on the target device (e.g. \"Safari\", \"Mail\", \"Calendar\") — the same " +
    "effect as the user opening it themselves from the Dock or Launchpad.",
  inputSchema: {
    type: "object",
    properties: {
      applicationName: { type: "string", description: "The application's display name, e.g. \"Safari\"." },
      deviceId: {
        type: "string",
        description: "Device to open the application on. Defaults to the primary device if omitted.",
      },
    },
    required: ["applicationName"],
  },
  requiredPermission: PermissionLevel.SAFE_ACTION,
  target: "device",
  validateInput(input) {
    return validateAppName(typeof input.applicationName === "string" ? input.applicationName : "");
  },
};
