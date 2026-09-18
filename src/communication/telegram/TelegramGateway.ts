import type { Orchestrator } from "@/core/orchestrator/Orchestrator";

export interface TelegramSession {
  orchestrator: Orchestrator;
  userId: string;
}

/** Builds a fresh session (its own conversation, sharing everything else) for one Telegram chat, on first message. */
export type TelegramSessionFactory = (chatId: string) => TelegramSession;

const TELEGRAM_API_BASE_URL = "https://api.telegram.org/bot";
const ERROR_MESSAGE = "Sorry, something went wrong on my end. Please try again.";

/**
 * A scoped Telegram integration — the user adds this specific bot to
 * specific chats, and JARVIS only ever sees/responds to messages sent to
 * it there, via Telegram's official Bot API. This is deliberately NOT
 * "read all of my Telegram messages": there is no code path here that
 * reads anything outside a chat this bot has actually been added to and
 * (when TELEGRAM_ALLOWED_CHAT_IDS is set) that chat is explicitly
 * allowlisted for.
 *
 * Each chat gets its own conversation thread (a fresh Orchestrator, kept
 * for the life of the process — unlike a phone call, a Telegram chat has
 * no natural "hang up") but shares every other live instance — same
 * JARVIS, separate conversation per chat.
 *
 * REQUIRES REAL VALIDATION: needs a real bot token from @BotFather and a
 * public HTTPS URL for Telegram's setWebhook to call. Never exercised
 * against a real Telegram account.
 */
export class TelegramGateway {
  private sessions: Map<string, TelegramSession> = new Map();

  constructor(
    private readonly botToken: string,
    private readonly createSession: TelegramSessionFactory,
    private readonly allowedChatIds?: string[]
  ) {}

  private getOrCreateSession(chatId: string): TelegramSession {
    let session = this.sessions.get(chatId);
    if (!session) {
      session = this.createSession(chatId);
      this.sessions.set(chatId, session);
    }
    return session;
  }

  isChatAllowed(chatId: string): boolean {
    if (!this.allowedChatIds || this.allowedChatIds.length === 0) return true;
    return this.allowedChatIds.includes(chatId);
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    const response = await fetch(`${TELEGRAM_API_BASE_URL}${this.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });

    if (!response.ok) {
      throw new Error(`Telegram sendMessage failed (${response.status}): ${await response.text().catch(() => "")}`);
    }
  }

  /**
   * Handles one Telegram Update webhook payload. Silently ignores anything
   * that isn't a plain text message (photos, stickers, service messages,
   * edits) — JARVIS only replies to messages it can actually understand.
   * Never throws: a brain/tool failure still gets a spoken-style error
   * reply back to the chat rather than a silently dropped message, and a
   * failure sending *that* is logged, not thrown, so a malformed or
   * malicious webhook body can never crash the server.
   */
  async handleUpdate(update: unknown): Promise<void> {
    const message = (update as { message?: { chat?: { id?: number | string }; text?: string } } | undefined)?.message;
    const chatId = message?.chat?.id;
    const text = message?.text;

    if (chatId === undefined || chatId === null || typeof text !== "string" || text.trim().length === 0) {
      return;
    }

    const chatIdStr = String(chatId);
    if (!this.isChatAllowed(chatIdStr)) {
      console.error(`[jarvis] rejected Telegram message from disallowed chat: ${chatIdStr}`);
      return;
    }

    const session = this.getOrCreateSession(chatIdStr);
    try {
      const reply = await session.orchestrator.handleUserMessage(session.userId, text);
      await this.sendMessage(chatIdStr, reply);
    } catch (error) {
      console.error(`[jarvis] Telegram message handling failed for chat ${chatIdStr}:`, error);
      await this.sendMessage(chatIdStr, ERROR_MESSAGE).catch((sendError) => {
        console.error(`[jarvis] Telegram error-reply send also failed for chat ${chatIdStr}:`, sendError);
      });
    }
  }
}
