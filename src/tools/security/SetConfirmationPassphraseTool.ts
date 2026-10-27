import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { ConfirmationPassphraseStore } from "@/security/ConfirmationPassphraseStore";

export interface SetConfirmationPassphraseInput extends Record<string, unknown> {
  passphrase: string;
}

const MIN_PASSPHRASE_LENGTH = 3;

/**
 * Sets (or changes) the shared passphrase JARVIS expects back before
 * treating a spoken reply to a proactive, JARVIS-initiated "wake up and
 * speak" reminder as really being the owner, rather than whoever happens
 * to be in the room (see SpeakerAuthenticator.ts and CLAUDE.md wishlist
 * #19). This is the ONLY way this value is set — there's no default, and
 * until it's set, every proactive announcement's reply is treated as
 * unauthenticated (see PassphraseSpeakerAuthenticator).
 *
 * CONFIRM, not SAFE_ACTION: changing the owner's own security passphrase
 * is exactly the kind of action that should never happen silently as a
 * side effect of an otherwise-ordinary conversation turn — the same
 * reasoning as UNLINK_CALENDAR/CLEAR_CONVERSATION_HISTORY.
 */
export function createSetConfirmationPassphraseTool(
  store: ConfirmationPassphraseStore
): LocalTool<SetConfirmationPassphraseInput> {
  return {
    id: "SET_CONFIRMATION_PASSPHRASE",
    name: "set_confirmation_passphrase",
    description:
      "Sets or changes the shared passphrase JARVIS expects to hear back before treating a spoken reply to " +
      "a proactive, JARVIS-initiated announcement (e.g. a device-spoken reminder) as really being the owner. " +
      'Use this when the user says something like "set my confirmation passphrase to ..." or "change my JARVIS ' +
      'code word to ...".',
    inputSchema: {
      type: "object",
      properties: {
        passphrase: { type: "string", description: "The new shared passphrase, spoken form (plain words are fine)." },
      },
      required: ["passphrase"],
    },
    requiredPermission: PermissionLevel.CONFIRM,
    target: "local",

    async execute(input) {
      if (typeof input.passphrase !== "string" || input.passphrase.trim().length < MIN_PASSPHRASE_LENGTH) {
        return { success: false, error: `passphrase must be a string of at least ${MIN_PASSPHRASE_LENGTH} characters` };
      }
      store.set(input.passphrase.trim());
      return { success: true, data: { set: true } };
    },
  };
}
