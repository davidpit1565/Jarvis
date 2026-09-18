import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { GmailClient } from "@/gmail/GmailClient";

export interface GetEmailInput extends Record<string, unknown> {
  messageId: string;
}

/**
 * SEARCH_EMAIL only returns a short snippet — this fetches one message's
 * full plain-text body by id, so Claude can actually answer questions
 * about what an email says rather than just that it exists. Same
 * read-only boundary as SEARCH_EMAIL: no send, delete, or modify.
 */
export function createGetEmailTool(gmailClient: GmailClient): LocalTool<GetEmailInput> {
  return {
    id: "GET_EMAIL",
    name: "get_email",
    description:
      "Fetches the full plain-text body of one email message, given its id from a prior search_email result. " +
      "Use this when the user asks what an email actually says, not just whether it exists. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "The message id, as returned by search_email." },
      },
      required: ["messageId"],
    },
    requiredPermission: PermissionLevel.READ,
    target: "local",

    async execute(input) {
      const messageId = typeof input.messageId === "string" ? input.messageId.trim() : "";
      if (!messageId) {
        return { success: false, error: "messageId must be a non-empty string" };
      }

      try {
        const message = await gmailClient.getMessageBody(messageId);
        return { success: true, data: message };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
