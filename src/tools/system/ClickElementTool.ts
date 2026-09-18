import { PermissionLevel } from "@/types/permissions";
import type { DeviceTool } from "@/types/tools";

/**
 * Clicks a UI element in the frontmost application on the target device,
 * matched by its accessible label/title/description — never by raw
 * screen coordinates. Direct user decision (see conversation history):
 * broader computer control is wanted, but strictly on-demand — "it
 * should always listen to me and never do things on its own initiative
 * unless I tell it to." The architecture already guarantees the "only
 * when asked" half (every tool call originates from Orchestrator.
 * handleUserMessage, which only ever runs in response to a real user
 * message — there is no autonomous background loop anywhere in this
 * codebase). This tool's own job is to make sure *what* it's authorized
 * to click is exactly what the person asked for, not a guess:
 *
 * - CONFIRM, not SAFE_ACTION: unlike OPEN_URL/OPEN_APPLICATION/
 *   COMPOSE_EMAIL_DRAFT (each a narrow, fully-specified, low-blast-radius
 *   action), a click can land on anything the frontmost app currently
 *   shows — including something destructive. CONFIRM means a human sees
 *   the exact element description and input before every single
 *   invocation and must say yes (ConfirmationService/confirmViaChat) —
 *   a standing grant is never enough on its own for this tool.
 * - Coordinates are deliberately not part of this tool's input at all —
 *   only a semantic description. A wrong coordinate (stale screenshot,
 *   resized window, different display scaling) can click anything;
 *   a wrong *label match* at least fails loudly (see the Agent's own
 *   "unique match or refuse" rule) rather than clicking a plausible
 *   wrong element silently.
 */
export const clickElementTool: DeviceTool = {
  id: "CLICK_ELEMENT",
  name: "click_element",
  description:
    "Clicks a UI element in the frontmost application on the target device, found by matching its " +
    "accessible label/title against the given description. Requires a unique match — if none or more " +
    "than one element matches, this fails rather than guessing which one was meant. Never accepts raw " +
    "screen coordinates.",
  inputSchema: {
    type: "object",
    properties: {
      description: {
        type: "string",
        description: "Text to match against the element's accessible label/title/description, e.g. \"Send\", \"Cancel\", \"Save\".",
      },
      deviceId: {
        type: "string",
        description: "Device to click on. Defaults to the primary device if omitted.",
      },
    },
    required: ["description"],
  },
  requiredPermission: PermissionLevel.CONFIRM,
  target: "device",
  validateInput(input) {
    const description = typeof input.description === "string" ? input.description.trim() : "";
    if (!description) {
      return { valid: false, reason: "description must be a non-empty string" };
    }
    return { valid: true };
  },
};
