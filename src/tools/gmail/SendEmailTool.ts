import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { GmailClient } from "@/gmail/GmailClient";

export interface SendEmailInput extends Record<string, unknown> {
  to: string;
  subject: string;
  body: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Actually sends a real email from the user's linked Gmail account — added
 * on the user's own explicit request, reversing this feature's original
 * read-only-by-design boundary (see GmailClient's doc comment). SAFE_ACTION
 * rather than CONFIRM/DANGEROUS: the effect is fully specified up front
 * (exact recipient, subject, body — nothing open-ended), matching
 * CREATE_CALENDAR_EVENT's reasoning, not CLICK_ELEMENT's. Still standing-
 * granted rather than confirmed per-call, same tradeoff as every other
 * SAFE_ACTION tool: asking every time would defeat the point of just
 * telling JARVIS to send it.
 */
export function createSendEmailTool(gmailClient: GmailClient): LocalTool<SendEmailInput> {
  return {
    id: "SEND_EMAIL",
    name: "send_email",
    description:
      "Sends a real, brand-new email from the user's linked Gmail account. Not a reply — use reply_email to " +
      "reply within an existing thread instead. Confirm the recipient, subject, and body content make sense " +
      "together before calling this; there is no draft/undo step once sent.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address." },
        subject: { type: "string", description: "Email subject line." },
        body: { type: "string", description: "Plain-text email body." },
      },
      required: ["to", "subject", "body"],
    },
    requiredPermission: PermissionLevel.SAFE_ACTION,
    target: "local",

    async execute(input) {
      const to = typeof input.to === "string" ? input.to.trim() : "";
      if (!to || !EMAIL_PATTERN.test(to)) {
        return { success: false, error: "to must be a valid email address" };
      }
      const subject = typeof input.subject === "string" ? input.subject : "";
      if (!subject.trim()) {
        return { success: false, error: "subject must be a non-empty string" };
      }
      const body = typeof input.body === "string" ? input.body : "";
      if (!body.trim()) {
        return { success: false, error: "body must be a non-empty string" };
      }

      try {
        const result = await gmailClient.sendMessage(to, subject, body);
        return { success: true, data: { messageId: result.id, to, subject } };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
