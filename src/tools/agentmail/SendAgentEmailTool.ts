import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { AgentMailClient } from "@/agentmail/AgentMailClient";
import type { AgentMailSendGuard } from "@/agentmail/AgentMailSendGuard";

export interface SendAgentEmailInput extends Record<string, unknown> {
  to: string;
  subject: string;
  body: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Sends a real email from JARVIS's OWN independent AgentMail inbox
 * (e.g. jarvis@agentmail.to) — NOT the user's personal Gmail account.
 * Wholly separate identity and wholly separate integration from
 * GmailClient/SEND_EMAIL: this never touches the user's linked Google
 * account at all.
 *
 * CONFIRM, not SAFE_ACTION — same reasoning as SEND_EMAIL's own doc
 * comment: sending a real, real-world email under any identity is a
 * side effect with no undo, and CHECK_AGENT_INBOX below feeds real
 * external message content (including anything a third party chooses to
 * put in a message body) straight into the model's context — the same
 * prompt-injection-to-exfiltration shape SEND_EMAIL was hardened
 * against. A fresh human confirmation on every send is the real backstop.
 *
 * Also enforced here: a config-driven daily send cap (`AgentMailSendGuard`,
 * same shape as `TwilioCostGuard`) — a misbehaving automation rule or a
 * runaway agent loop can't turn this into an unbounded number of real
 * sends in a day.
 */
export function createSendAgentEmailTool(
  agentMailClient: AgentMailClient,
  sendGuard: AgentMailSendGuard,
  todayDateKey: () => string
): LocalTool<SendAgentEmailInput> {
  return {
    id: "SEND_AGENT_EMAIL",
    name: "send_agent_email",
    description:
      "Sends a real email from JARVIS's own independent AgentMail inbox — a separate identity from the user's " +
      "personal Gmail account, not a replacement for send_email. Use this only when the user explicitly wants " +
      "JARVIS itself to send mail as its own sender (e.g. to another service or agent), not to send mail on the " +
      "user's own behalf. There is no draft/undo step once sent, and a daily send cap applies.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address." },
        subject: { type: "string", description: "Email subject line." },
        body: { type: "string", description: "Plain-text email body." },
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

      if (!sendGuard.tryConsume(todayDateKey())) {
        return {
          success: false,
          error: "Daily send limit for JARVIS's AgentMail inbox has been reached — try again tomorrow.",
        };
      }

      try {
        const result = await agentMailClient.sendMessage(to, subject, body);
        return { success: true, data: { messageId: result.messageId, threadId: result.threadId, to, subject } };
      } catch (error) {
        // The consumed slot was for a send that never actually happened —
        // refund it so a transient AgentMail failure doesn't burn real
        // quota and falsely trip the daily cap for the rest of the day.
        sendGuard.release(todayDateKey());
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
