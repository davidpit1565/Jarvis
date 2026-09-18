import { PermissionLevel } from "@/types/permissions";
import type { DeviceTool } from "@/types/tools";

/**
 * Types text into whatever currently has keyboard focus on the target
 * device — a real keystroke simulation, not a clipboard paste (so it
 * respects whatever the focused field actually does with typed input:
 * autocomplete, validation-as-you-type, etc., the same as a person
 * typing it). CONFIRM, same reasoning as ClickElementTool: this can type
 * into anything currently focused, so a human sees the exact text before
 * every single invocation and must approve it — never a standing grant
 * alone. Deliberately no way to also specify *where* to type (no element
 * targeting here) — combine with CLICK_ELEMENT first to focus the right
 * field, each step visibly confirmed on its own.
 */
export const typeTextTool: DeviceTool = {
  id: "TYPE_TEXT",
  name: "type_text",
  description:
    "Types text into whichever UI element currently has keyboard focus on the target device, as real " +
    "simulated keystrokes. Does not select or focus anything itself — use click_element first if a " +
    "specific field needs focus.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "The text to type." },
      deviceId: {
        type: "string",
        description: "Device to type on. Defaults to the primary device if omitted.",
      },
    },
    required: ["text"],
  },
  requiredPermission: PermissionLevel.CONFIRM,
  target: "device",
  validateInput(input) {
    if (typeof input.text !== "string" || input.text.length === 0) {
      return { valid: false, reason: "text must be a non-empty string" };
    }
    return { valid: true };
  },
};
