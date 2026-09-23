import type { Orchestrator } from "@/core/orchestrator/Orchestrator";
import { fetchWithRetry } from "@/core/net/fetchWithRetry";

export interface TelegramSession {
  orchestrator: Orchestrator;
  userId: string;
}

/** Builds a fresh session (its own conversation, sharing everything else) for one Telegram chat, on first message. */
export type TelegramSessionFactory = (chatId: string) => TelegramSession;

const TELEGRAM_API_BASE_URL = "https://api.telegram.org/bot";
const ERROR_MESSAGE = "Sorry, something went wrong on my end. Please try again.";

// Sending is not idempotent: unlike a read, retrying a send after a network
// error or a Telegram-side 5xx risks posting the same text/photo/document a
// second time if Telegram actually received and processed the first attempt
// before the response was lost. Only retry 429 (rate-limited — the request
// never reached processing), matching GmailClient/AgentMailClient's own
// SEND_RETRY_OPTIONS for the same reason.
const SEND_RETRY_OPTIONS = { retryableStatuses: (status: number) => status === 429, retryNetworkErrors: false };

// Telegram's Bot API rejects any message text over 4096 characters with a
// 400. Anything JARVIS actually says (a news digest, a long memory/reminder
// listing) can easily exceed that, so outgoing text is split into chunks
// this size or smaller before sending.
const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

/** Splits `text` into chunks Telegram will accept, preferring to break on a newline near the limit. */
function splitIntoTelegramChunks(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_MESSAGE_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > TELEGRAM_MAX_MESSAGE_LENGTH) {
    const window = remaining.slice(0, TELEGRAM_MAX_MESSAGE_LENGTH);
    const breakAt = window.lastIndexOf("\n");
    const splitAt = breakAt > 0 ? breakAt : TELEGRAM_MAX_MESSAGE_LENGTH;

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

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
const YES_PATTERN = /^\s*(yes|y|כן|אישור|confirm)\s*$/i;
const NO_PATTERN = /^\s*(no|n|לא|ביטול|cancel)\s*$/i;

const HELP_MESSAGE =
  "I'm JARVIS. Just message me normally — no special syntax needed. I can help with reminders, your " +
  "calendar, email search, weather, news, and more, depending on what's been configured.";
const START_MESSAGE = `Hi, I'm JARVIS. ${HELP_MESSAGE}`;

export class TelegramGateway {
  private sessions: Map<string, TelegramSession> = new Map();
  private pendingConfirmations: Map<string, (answer: boolean) => void> = new Map();

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

  /**
   * Asks a real yes/no question over Telegram and waits for the chat's next
   * reply to answer it — unlike a phone call, a Telegram chat is a reliable
   * bidirectional text channel, so it gets the same real confirmation UX as
   * the terminal instead of being auto-denied. Only one confirmation can be
   * pending per chat at a time; a new one silently replaces (and orphans)
   * any prior unanswered entry for that chat, which is fine because
   * `ConfirmationService`'s own timeout already resolves the caller waiting
   * on that stale prompt with `false`.
   */
  async awaitConfirmation(chatId: string, questionText: string): Promise<boolean> {
    const resultPromise = new Promise<boolean>((resolve) => {
      this.pendingConfirmations.set(chatId, resolve);
    });
    await this.sendMessage(chatId, questionText);
    return resultPromise;
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    for (const chunk of splitIntoTelegramChunks(text)) {
      // Bounded fetch (timeout + retry-with-backoff on Telegram's own
      // 429/5xx) — Telegram's Bot API rate-limits outbound sends per bot
      // (roughly 30 messages/second, tighter per-chat), and this is the
      // gateway's only outbound call site that user-visible activity (a
      // busy digest, a burst of automation replies) can realistically
      // drive into that limit.
      const response = await fetchWithRetry(
        `${TELEGRAM_API_BASE_URL}${this.botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: chunk }),
        },
        SEND_RETRY_OPTIONS
      );

      if (!response.ok) {
        throw new Error(`Telegram sendMessage failed (${response.status}): ${await response.text().catch(() => "")}`);
      }
    }
  }

  /**
   * Sends a photo given a public URL — used by GENERATE_IMAGE to deliver a
   * Pollinations-generated image. Telegram fetches the URL itself
   * server-side (a plain JSON POST, not multipart), so the image bytes
   * never pass through this process at all — distinct from sendDocument
   * above, which uploads bytes Core already has in hand.
   */
  async sendPhoto(chatId: string, photoUrl: string, caption?: string): Promise<void> {
    const body: Record<string, string> = { chat_id: chatId, photo: photoUrl };
    if (caption) body.caption = caption.slice(0, 1024); // Telegram's own caption length limit

    const response = await fetchWithRetry(
      `${TELEGRAM_API_BASE_URL}${this.botToken}/sendPhoto`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      SEND_RETRY_OPTIONS
    );

    if (!response.ok) {
      throw new Error(`Telegram sendPhoto failed (${response.status}): ${await response.text().catch(() => "")}`);
    }
  }

  // 50MB is Telegram's own bot-API document upload limit — this check is
  // defense in depth, not the real cap: ShareFileToPhoneTool's own
  // caller-provided base64Content is realistically already bounded by
  // READ_FILE_BYTES's 150KB device-side cap.
  private static readonly MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

  /**
   * Uploads a file to the chat as a real Telegram document — the delivery
   * half of SHARE_FILE_TO_PHONE, given bytes already read off the Mac by
   * READ_FILE_BYTES. Multipart/form-data, distinct from sendMessage's
   * plain JSON POST, since Telegram's sendDocument endpoint expects an
   * actual file upload.
   */
  async sendDocument(chatId: string, base64Content: string, filename: string): Promise<void> {
    const bytes = Buffer.from(base64Content, "base64");
    if (bytes.length === 0) {
      throw new Error("base64Content decoded to zero bytes");
    }
    if (bytes.length > TelegramGateway.MAX_DOCUMENT_BYTES) {
      throw new Error(`File is ${bytes.length} bytes, over Telegram's ${TelegramGateway.MAX_DOCUMENT_BYTES}-byte document limit`);
    }

    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("document", new Blob([bytes]), filename);

    const response = await fetchWithRetry(
      `${TELEGRAM_API_BASE_URL}${this.botToken}/sendDocument`,
      {
        method: "POST",
        body: form,
      },
      SEND_RETRY_OPTIONS
    );

    if (!response.ok) {
      throw new Error(`Telegram sendDocument failed (${response.status}): ${await response.text().catch(() => "")}`);
    }
  }

  /**
   * Handles one Telegram Update webhook payload. Silently ignores anything
   * with no chat to reply to (service messages, edits) — JARVIS only
   * replies to messages it can actually understand. A photo, voice note,
   * or document gets a short "text only for now" reply instead of being
   * dropped, since vision/audio input isn't wired up on this channel yet
   * and a silent non-response reads as "the bot is broken".
   * Never throws: a brain/tool failure still gets a spoken-style error
   * reply back to the chat rather than a silently dropped message, and a
   * failure sending *that* is logged, not thrown, so a malformed or
   * malicious webhook body can never crash the server.
   */
  async handleUpdate(update: unknown): Promise<void> {
    const message = (
      update as
        | { message?: { chat?: { id?: number | string }; text?: string; photo?: unknown; voice?: unknown; document?: unknown } }
        | undefined
    )?.message;
    const chatId = message?.chat?.id;
    const text = message?.text;

    if (chatId === undefined || chatId === null) {
      return;
    }

    const chatIdStr = String(chatId);
    if (!this.isChatAllowed(chatIdStr)) {
      console.error(`[jarvis] rejected Telegram message from disallowed chat: ${chatIdStr}`);
      return;
    }

    if (typeof text !== "string" || text.trim().length === 0) {
      if (message?.photo || message?.voice || message?.document) {
        await this.sendMessage(chatIdStr, "I can't read photos, voice notes, or files here yet — just text for now.").catch(() => {});
      }
      return;
    }

    const pendingResolve = this.pendingConfirmations.get(chatIdStr);
    if (pendingResolve) {
      if (YES_PATTERN.test(text)) {
        this.pendingConfirmations.delete(chatIdStr);
        pendingResolve(true);
        await this.sendMessage(chatIdStr, "Confirmed.").catch(() => {});
        return;
      }
      if (NO_PATTERN.test(text)) {
        this.pendingConfirmations.delete(chatIdStr);
        pendingResolve(false);
        await this.sendMessage(chatIdStr, "Cancelled.").catch(() => {});
        return;
      }
      await this.sendMessage(chatIdStr, "Please reply yes or no.").catch(() => {});
      return;
    }

    // Telegram's own bot commands (BotFather-registered or not) — answered
    // locally, with no brain call, so a new chat's "/start" tap doesn't
    // burn a real API request on a canned greeting.
    const trimmedText = text.trim();
    if (trimmedText === "/start") {
      await this.sendMessage(chatIdStr, START_MESSAGE).catch(() => {});
      return;
    }
    if (trimmedText === "/help") {
      await this.sendMessage(chatIdStr, HELP_MESSAGE).catch(() => {});
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
