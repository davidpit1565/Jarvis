import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { CalendarTokenStore } from "@/calendar/CalendarTokenStore";

export interface ListLinkedGoogleAccountsInput extends Record<string, unknown> {}

/**
 * Pure read of which Google accounts are currently linked — the one real
 * gap identified once David started linking multiple Google accounts
 * (work, personal, another work email). Without this, the model only ever
 * learned the linked-account list indirectly, e.g. from UNLINK_CALENDAR's
 * error message when `account` didn't match. This lets the model answer
 * "which email is linked right now" directly, and make good
 * account-name-matching decisions before calling a Calendar/Gmail/Drive
 * tool with an `account` argument (e.g. "search the Solfay inbox").
 *
 * No side effects, no confirmation needed — READ, like the other
 * list/search calendar tools.
 */
export function createListLinkedGoogleAccountsTool(calendarTokenStore: CalendarTokenStore): LocalTool<ListLinkedGoogleAccountsInput> {
  return {
    id: "LIST_LINKED_GOOGLE_ACCOUNTS",
    name: "list_linked_google_accounts",
    description:
      "Lists every Google account currently linked to JARVIS (email address, and when it was linked), oldest/primary " +
      "first. Use this to answer questions like 'which email is linked right now' or to work out which linked " +
      "account's name best matches what the user means (e.g. 'the Solfay inbox') before passing `account` to a " +
      "Calendar/Gmail/Drive tool. Read-only — no side effects.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    requiredPermission: PermissionLevel.READ,
    target: "local",

    async execute() {
      const accounts = calendarTokenStore.getAll().map((a) => ({ email: a.email, linkedAt: a.linkedAt }));
      return {
        success: true,
        data: { accounts, count: accounts.length },
      };
    },
  };
}
