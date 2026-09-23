import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { TwilioSmsSender } from "@/communication/phone/TwilioSmsSender";
import type { TwilioCostGuard } from "@/communication/phone/TwilioCostGuard";

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
 *
 * Also enforced here: a config-driven daily send cap (`TwilioCostGuard`,
 * the same class already gating the wake-up-call scheduler's outbound
 * calls) — without this, a misconfigured automation rule or a runaway
 * agent loop could rack up an unbounded number of real, Twilio-billed
 * texts in a day, exactly the gap `TwilioCostGuard`/`AgentMailSendGuard`
 * already close for outbound calls and SEND_AGENT_EMAIL.
 */
export function createSendSmsTool(
  smsSender: TwilioSmsSender,
  ownerPhoneNumber: string,
  sendGuard: TwilioCostGuard,
  todayDateKey: () => string
): LocalTool<SendSmsInput> {
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

      // Captured once and reused for both tryConsume/release below — the
      // sendSms() call below awaits a real network round trip, and
      // re-invoking todayDateKey() separately at each point could land on
      // a different day if local midnight ticks over while that call is
      // in flight, silently consuming one day's slot but refunding a
      // different (untouched) day's counter instead. Same reasoning as
      // the wake-up-call scheduler's single `todayDateStr` capture in
      // index.ts.
      const dayKey = todayDateKey();

      if (!sendGuard.tryConsume(dayKey)) {
        return {
          success: false,
          error: "Daily SMS send limit has been reached — try again tomorrow.",
        };
      }

      try {
        const result = await smsSender.sendSms(ownerPhoneNumber, message);
        return { success: true, data: { messageSid: result.messageSid } };
      } catch (error) {
        // The consumed slot was for a send that never actually happened —
        // refund it so a transient Twilio failure doesn't burn real
        // quota and falsely trip the daily cap for the rest of the day.
        sendGuard.release(dayKey);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
