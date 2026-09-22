import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { CalendarTokenStore } from "@/calendar/CalendarTokenStore";

export interface UnlinkCalendarInput extends Record<string, unknown> {
  /** The linked account's email to unlink. Required when more than one Google account is linked. */
  account?: string;
}

/**
 * Lets the user actually disconnect a linked Google account — without
 * this, once linked via /calendar/oauth/start there was no way to undo it
 * short of manually deleting the SQLite file. DANGEROUS (like
 * CLEAR_CONVERSATION_HISTORY): disconnecting a real third-party account
 * link always needs a fresh confirmation, never something that happens
 * as a side effect of casual conversation.
 *
 * Multiple accounts can be linked at once (see CalendarTokenStore), so
 * this needs to know WHICH one to unlink. With exactly one linked, that's
 * unambiguous and `account` can be omitted. With more than one and no
 * `account` given, this deliberately doesn't guess — it lists the linked
 * accounts in its result so the model/user can pick, then call again with
 * `account` set.
 */
export function createUnlinkCalendarTool(calendarTokenStore: CalendarTokenStore): LocalTool<UnlinkCalendarInput> {
  return {
    id: "UNLINK_CALENDAR",
    name: "unlink_calendar",
    description:
      "Disconnects a linked Google account. With more than one account linked, `account` (its email) is " +
      "required — call without it first to get back the list of linked accounts to choose from. After " +
      "unlinking, that account's calendar/email stop being included until the user re-links it via " +
      "GET /calendar/oauth/start. Use only when the user explicitly asks to disconnect/unlink an account.",
    inputSchema: {
      type: "object",
      properties: {
        account: {
          type: "string",
          description:
            "The linked account's email to unlink. Required when more than one Google account is linked; optional (and unambiguous) when exactly one is.",
        },
      },
    },
    requiredPermission: PermissionLevel.DANGEROUS,
    target: "local",

    async execute(input) {
      const linkedAccounts = calendarTokenStore.getAll().map((a) => a.email);
      const account = typeof input.account === "string" && input.account.trim() !== "" ? input.account.trim() : undefined;

      if (account) {
        const wasLinked = calendarTokenStore.isLinked(account);
        calendarTokenStore.delete(account);
        return {
          success: true,
          data: { wasLinked, account, linkedAccounts: linkedAccounts.filter((email) => email !== account) },
        };
      }

      if (linkedAccounts.length === 0) {
        return { success: true, data: { wasLinked: false, linkedAccounts: [] } };
      }

      if (linkedAccounts.length > 1) {
        return {
          success: false,
          error: `More than one Google account is linked — specify which to unlink by email: ${linkedAccounts.join(", ")}`,
          data: { linkedAccounts },
        };
      }

      // Exactly one linked account: unambiguous, so unlink it without
      // requiring the caller to name it.
      const only = linkedAccounts[0]!;
      calendarTokenStore.delete(only);
      return { success: true, data: { wasLinked: true, account: only, linkedAccounts: [] } };
    },
  };
}
