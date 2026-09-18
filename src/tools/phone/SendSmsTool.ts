import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { TwilioSmsSender } from "@/communication/phone/TwilioSmsSender";

export interface SendSmsInput extends Record<string, unknown> {
  message: string;
}

// Twilio splits/bills SMS in ~153-char segments once a message needs
// concatenation; 1600 chars (~10-11 segments) is generous for anything a
// person would actually dictate as a text, while still bounding the
// per-call cost if a huge value (e.g. an entire prompt-injected email
// body) ever ended up here instead of a short message.
const MAX_MESSAGE_LENGTH = 1600;

/**
 * A second real "reach the phone" channel alongside Telegram — official,
 * Twilio-billed SMS, useful when the user isn't on Telegram or wants a
 * plain text message instead. Deliberately no "to" parameter, same
 * reasoning as NOTIFY_USER: this always sends to the owner's own
 * configured phone number, never an arbitrary one, so it can't become a
 * cost/harassment vector via a prompt-injected "to" value from something
 * JARVIS read (an email, a calendar invite).
 */
export function createSendSmsTool(smsSender: TwilioSmsSender, ownerPhoneNumber: string): LocalTool<SendSmsInput> {
  return {
    id: "SEND_SMS",
    name: "send_sms",
    description:
      "Sends a real text message (SMS) to the user's own phone via Twilio. Use this for \"text me...\" or as " +
      "an alternative to notify_user (Telegram) when the user specifically wants a text message instead. " +
      `Message is capped at ${MAX_MESSAGE_LENGTH} characters.`,
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "The SMS body text." },
      },
      required: ["message"],
    },
    requiredPermission: PermissionLevel.SAFE_ACTION,
    target: "local",

    async execute(input) {
      const message = typeof input.message === "string" ? input.message.trim() : "";
      if (!message) {
        return { success: false, error: "message must be a non-empty string" };
      }
      if (message.length > MAX_MESSAGE_LENGTH) {
        return { success: false, error: `message is too long (over ${MAX_MESSAGE_LENGTH} characters)` };
      }

      try {
        const result = await smsSender.sendSms(ownerPhoneNumber, message);
        return { success: true, data: { messageSid: result.messageSid } };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
