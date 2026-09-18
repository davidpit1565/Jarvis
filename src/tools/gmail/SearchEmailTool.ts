import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { GmailClient } from "@/gmail/GmailClient";

export interface SearchEmailInput extends Record<string, unknown> {
  query: string;
  maxResults?: number;
}

/**
 * Lets Claude answer "did I get an email from X" / "any unread mail about Y"
 * with the user's real Gmail inbox. READ-only — JARVIS can search and read
 * subject/sender/date/snippet, never send, delete, or modify anything, and
 * only against whatever Gmail's own search syntax (e.g. "from:x is:unread",
 * "subject:invoice") matches — not a dump of the whole mailbox.
 */
export function createSearchEmailTool(gmailClient: GmailClient): LocalTool<SearchEmailInput> {
  return {
    id: "SEARCH_EMAIL",
    name: "search_email",
    description:
      "Searches the user's Gmail inbox using Gmail's own search syntax (e.g. \"from:alice is:unread\", " +
      '"subject:invoice", "newer_than:2d") and returns matching messages\' subject, sender, date, and a short ' +
      "snippet. Read-only — cannot send, delete, or modify email.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Gmail search query, using Gmail's own search operators." },
        maxResults: { type: "number", description: "Maximum number of messages to return. Defaults to 5, capped at 10." },
      },
      required: ["query"],
    },
    requiredPermission: PermissionLevel.READ,
    target: "local",

    async execute(input) {
      const query = typeof input.query === "string" ? input.query.trim() : "";
      if (!query) {
        return { success: false, error: "query must be a non-empty string" };
      }

      const maxResults = typeof input.maxResults === "number" ? input.maxResults : undefined;
      if (maxResults !== undefined && (!Number.isInteger(maxResults) || maxResults <= 0)) {
        return { success: false, error: "maxResults must be a positive integer" };
      }

      try {
        const messages = await gmailClient.searchMessages(query, maxResults);
        return { success: true, data: { messages } };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
