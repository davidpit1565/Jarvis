import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { GmailClient } from "@/gmail/GmailClient";

export interface SendEmailInput extends Record<string, unknown> {
  to: string;
  subject: string;
  body: string;
  /** Which linked Google account to send from, by email. Omit to use whichever account was linked first. */
  account?: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Actually sends a real email from the user's linked Gmail account — added
 * on the user's own explicit request, reversing this feature's original
 * read-only-by-design boundary (see GmailClient's doc comment).
 *
 * CONFIRM, not SAFE_ACTION — found during a later security review:
 * SEND_EMAIL's blast radius isn't "fully specified and self-contained"
 * the way CREATE_CALENDAR_EVENT's is. JARVIS also has read tools
 * (search_email/get_email) that feed real inbox content — including
 * anything an attacker chooses to put in an email body — straight into
 * the model's own context. The system prompt already tells the model not
 * to treat fetched content as instructions, but that's an instruction to
 * a model, not a technical control; SEND_EMAIL is the one tool that can
 * turn a successful prompt injection into real third-party data
 * exfiltration (unlike SEND_SMS/SHARE_FILE_TO_PHONE, which are hardcoded
 * to the owner's own number/chat and can't be redirected at all). CONFIRM
 * forces a fresh human confirmation on every single send, the same
 * treatment WRITE_FILE gets for its own no-undo risk — this is the real
 * backstop when the prompt-level guardrail alone isn't enough.
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
        account: {
          type: "string",
          description:
            "Which linked Google account to send from, by email. Omit to use whichever account was linked first — only needed when the user explicitly names a specific account (e.g. \"send it from my work email\").",
        },
      },
      required: ["to", "subject", "body"],
    },
    requiredPermission: PermissionLevel.CONFIRM,
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
      if (input.account !== undefined && typeof input.account !== "string") {
        return { success: false, error: "account must be a string" };
      }

      try {
        const result = await gmailClient.sendMessage(to, subject, body, input.account);
        return { success: true, data: { messageId: result.id, to, subject, account: result.account } };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
