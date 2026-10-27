import { PermissionLevel } from "@/types/permissions";
import type { LocalTool, ToolExecutionContext, ToolResult } from "@/types/tools";

export interface OpenChatInput extends Record<string, unknown> {}

/**
 * Channels where the conversation is a live, voice-only phone call —
 * reciting a URL character-by-character down a phone line isn't a
 * realistic way to hand someone a link they can actually tap, unlike
 * texting or a chat message, which they can read and act on at their own
 * pace. See channelContext in `src/index.ts` for where each of these
 * strings comes from.
 */
const VOICE_ONLY_CHANNELS = new Set(["phone", "wakeup-call"]);

/**
 * Backs wishlist item #22 ("open your chat" / "פתח את הצ'אט שלך"): gives
 * the user a real, persistent place to keep talking to JARVIS, on
 * whichever channel they're currently using.
 *
 * Deliberately honest about what "open" can mean per channel, since
 * there's no universal "open an app on whatever device you're on"
 * capability in this codebase:
 * - Already on Telegram: this is that chat already. Handled by
 *   `JARVIS_SYSTEM_PROMPT` guidance, not this tool — calling this tool
 *   from Telegram would be pointless, but it still answers sanely if the
 *   model does anyway (see the `telegram` branch below).
 * - Any other text- or voice-capable channel (the default web/terminal
 *   chat, SMS, or the Mac voice agent): returns a `https://t.me/<bot>`
 *   deep link as data. Delivering it is then just the model's normal
 *   reply, which each channel's own gateway already turns into a text
 *   message, an SMS, or spoken text, exactly like any other tool result —
 *   this tool does not itself send anything.
 * - A live phone call (inbound or JARVIS's own wake-up call): a spoken
 *   URL isn't something the user can tap, so this reports plainly that
 *   it's not available right now rather than "succeeding" with a link
 *   nobody can use.
 * - No TELEGRAM_BOT_USERNAME configured: reports that plainly too,
 *   instead of guessing at a bot username or fabricating a link.
 */
export function createOpenChatTool(telegramBotUsername: string | undefined): LocalTool<OpenChatInput> {
  return {
    id: "OPEN_CHAT",
    name: "open_chat",
    description:
      'Use when the user asks you to "open your chat", "open a chat with you", or similar — they want a ' +
      "persistent place to keep talking to JARVIS, not just this one reply. If the user is already talking to " +
      "you over Telegram, don't call this — just tell them this already is that chat. On any other channel, " +
      "this gives you a link to JARVIS's Telegram chat to pass along, or honestly says why one isn't available " +
      "right now (a live phone call, or no Telegram bot username configured).",
    inputSchema: {
      type: "object",
      properties: {},
    },
    requiredPermission: PermissionLevel.SAFE_ACTION,
    target: "local",

    async execute(_input: OpenChatInput, context: ToolExecutionContext): Promise<ToolResult> {
      const channel = context.channel ?? "chat";

      if (channel === "telegram") {
        return {
          success: true,
          data: {
            channel,
            alreadyInChat: true,
            note: "The user is already talking to JARVIS inside the Telegram chat — there's nothing to open.",
          },
        };
      }

      if (!telegramBotUsername) {
        return {
          success: false,
          error:
            "No Telegram bot username is configured (TELEGRAM_BOT_USERNAME) — there's no link to give the user " +
            "for a persistent chat right now.",
        };
      }

      if (VOICE_ONLY_CHANNELS.has(channel)) {
        return {
          success: false,
          error:
            "A live phone call has no way to hand the user a tappable link — reciting a URL aloud isn't a " +
            "realistic way to open a chat. Tell them plainly this isn't available on a call, and that they can " +
            "message JARVIS on Telegram directly instead.",
        };
      }

      const link = `https://t.me/${telegramBotUsername}`;
      return {
        success: true,
        data: {
          channel,
          link,
          note:
            channel === "device-voice"
              ? "Pass this link along; since the user is on their Mac, you may also use OPEN_URL to open it there directly."
              : "Pass this link along as part of your reply so the user can tap it.",
        },
      };
    },
  };
}
