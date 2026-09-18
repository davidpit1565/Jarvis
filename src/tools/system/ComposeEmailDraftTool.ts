import { PermissionLevel } from "@/types/permissions";
import type { DeviceTool } from "@/types/tools";
import { validateEmailAddress } from "./emailValidation";

/**
 * Opens a pre-filled email DRAFT in the target device's default mail
 * client (via a `mailto:` URL) — it never sends anything. The user always
 * sees the composed message and must click Send themselves, exactly like
 * clicking a "mailto:" link on a web page. This is the deliberate scope:
 * an actual "send this email" tool is a real, one-way action (DANGEROUS
 * territory — see PermissionLevel) that deserves its own explicit
 * decision and confirmation flow, not something to fold into "prepare an
 * email for me" by default.
 */
export const composeEmailDraftTool: DeviceTool = {
  id: "COMPOSE_EMAIL_DRAFT",
  name: "compose_email_draft",
  description:
    "Opens a pre-filled email draft (recipient/subject/body) in the default mail client on the target " +
    "device. Never sends the email — the user reviews and sends it themselves.",
  inputSchema: {
    type: "object",
    properties: {
      to: { type: "string", description: "Recipient email address." },
      subject: { type: "string", description: "Email subject line." },
      body: { type: "string", description: "Email body text." },
      deviceId: {
        type: "string",
        description: "Device to open the draft on. Defaults to the primary device if omitted.",
      },
    },
    required: ["to"],
  },
  requiredPermission: PermissionLevel.SAFE_ACTION,
  target: "device",
  validateInput(input) {
    return validateEmailAddress(typeof input.to === "string" ? input.to : "");
  },
};
