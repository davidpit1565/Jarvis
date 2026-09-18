import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { TelegramGateway } from "@/communication/telegram/TelegramGateway";

export interface NotifyUserInput extends Record<string, unknown> {
  message: string;
}

/**
 * Lets JARVIS reach the user's phone from any channel it's currently
 * talking to them on — most usefully the terminal/Mac, so "tell me on my
 * phone when the build finishes" actually works. Pushes a Telegram
 * message to the owner's own chat; the reverse direction (phone/Telegram
 * asking JARVIS to act on the Mac) already works today since every
 * channel shares the same tool registry and device connection.
 */
export function createNotifyUserTool(telegramGateway: TelegramGateway, ownerChatId: string): LocalTool<NotifyUserInput> {
  return {
    id: "NOTIFY_USER",
    name: "notify_user",
    description:
      "Sends a text notification to the user's phone (via Telegram), regardless of which channel this " +
      'conversation is happening on. Use this for "tell me on my phone when...", "notify me if...", or any ' +
      "case where the user wants to be reached somewhere other than where they're talking to you right now.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "The notification text to send." },
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

      try {
        await telegramGateway.sendMessage(ownerChatId, message);
        return { success: true, data: { sent: true } };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
