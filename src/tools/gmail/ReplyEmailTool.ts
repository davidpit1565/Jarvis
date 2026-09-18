import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { GmailClient } from "@/gmail/GmailClient";

export interface ReplyEmailInput extends Record<string, unknown> {
  messageId: string;
  body: string;
}

/**
 * Replies within an existing Gmail thread — recipient, subject (with a
 * "Re:" prefix), and threading headers are derived from the original
 * message via GmailClient.replyToMessage, not supplied by the caller, so
 * this can never be redirected to send to someone other than whoever the
 * original message actually came from. Same SAFE_ACTION reasoning as
 * SEND_EMAIL: fully specified effect once messageId + body are given.
 */
export function createReplyEmailTool(gmailClient: GmailClient): LocalTool<ReplyEmailInput> {
  return {
    id: "REPLY_EMAIL",
    name: "reply_email",
    description:
      "Replies within an existing Gmail thread, given the messageId of the message being replied to (from " +
      "search_email or get_email). The reply is sent to whoever the original message came from, with the " +
      'subject and threading handled automatically — do not include a "Re:" prefix or quote the original ' +
      "message yourself.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "The Gmail message id of the message to reply to." },
        body: { type: "string", description: "Plain-text reply body." },
      },
      required: ["messageId", "body"],
    },
    requiredPermission: PermissionLevel.SAFE_ACTION,
    target: "local",

    async execute(input) {
      const messageId = typeof input.messageId === "string" ? input.messageId.trim() : "";
      if (!messageId) {
        return { success: false, error: "messageId must be a non-empty string" };
      }
      const body = typeof input.body === "string" ? input.body : "";
      if (!body.trim()) {
        return { success: false, error: "body must be a non-empty string" };
      }

      try {
        const result = await gmailClient.replyToMessage(messageId, body);
        return { success: true, data: { messageId: result.id, inReplyTo: messageId } };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
