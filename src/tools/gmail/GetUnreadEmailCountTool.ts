import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { GmailClient } from "@/gmail/GmailClient";

/**
 * Just the unread count — for "do I have unread emails" / "how many
 * unread emails do I have," which only ever needs a number. Meaningfully
 * cheaper than search_email("is:unread") since it never fetches each
 * message's subject/sender/date. Same read-only boundary as the other
 * Gmail tools.
 */
export function createGetUnreadEmailCountTool(gmailClient: GmailClient): LocalTool {
  return {
    id: "GET_UNREAD_EMAIL_COUNT",
    name: "get_unread_email_count",
    description:
      'Returns just the number of unread emails in the inbox. Use this for "do I have unread emails" / ' +
      '"how many unread emails do I have" — for the actual messages, use search_email("is:unread") instead.',
    inputSchema: { type: "object", properties: {} },
    requiredPermission: PermissionLevel.READ,
    target: "local",

    async execute() {
      try {
        const count = await gmailClient.getMessageCount("is:unread");
        return { success: true, data: { count } };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
