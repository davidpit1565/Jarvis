import { randomUUID } from "node:crypto";
import type { Orchestrator } from "@/core/orchestrator/Orchestrator";
import type { DeviceConnectionManager } from "@/communication/websocket/DeviceConnectionManager";
import { makeEnvelope } from "@/communication/websocket/protocol";

export interface DeviceVoiceSession {
  orchestrator: Orchestrator;
  userId: string;
}

/** Builds a fresh session (its own conversation, sharing everything else) for one paired device, on first transcript. */
export type DeviceVoiceSessionFactory = (deviceId: string) => DeviceVoiceSession;

const ERROR_MESSAGE = "Sorry, something went wrong on my end. Please try again.";

const YES_PATTERN = /^\s*(yes|y|כן|אישור|confirm)\s*$/i;
const NO_PATTERN = /^\s*(no|n|לא|ביטול|cancel)\s*$/i;

/**
 * Wraps a voice command with an explicit reply-language directive when the
 * wake phrase forced one ("Hey JARVIS" -> "en", "Jarvis Shomea" -> "he") —
 * without this, Claude's own bilingual auto-detection (see systemPrompt.ts)
 * would pick the command's own language, so a Hebrew sentence said after
 * the English wake phrase would still get answered in Hebrew instead of
 * the forced English the user actually asked for by using that phrase.
 * `language` is `undefined` for every other channel and for a
 * clap-triggered command, which fall back to plain auto-detection as before.
 */
function applyLanguageDirective(text: string, language: string | undefined): string {
  if (language === "en") return `[Reply in English regardless of what language this is in] ${text}`;
  if (language === "he") return `[ענה בעברית בלי קשר לשפה של המשפט הזה] ${text}`;
  return text;
}

/**
 * Routes wake-word-triggered voice transcripts from a paired device (the
 * Mac agent today, an iPhone one later) through the same
 * `Orchestrator.handleUserMessage` path as every other channel (Telegram,
 * phone) — one conversation per device, kept for the life of the process
 * the same way a Telegram chat is. Replies are spoken back on-device by
 * the agent itself (see `voice.reply` in protocol.ts); this class only
 * decides what text to send back.
 *
 * Only ever reachable from an already-paired, authenticated device
 * connection — `JarvisWebSocketServer` only accepts `voice.transcript`
 * from a socket `DeviceConnectionManager` already trusts, the same gate
 * every other post-pairing message type goes through.
 */
export class DeviceVoiceGateway {
  private sessions: Map<string, DeviceVoiceSession> = new Map();
  private pendingConfirmations: Map<string, (answer: boolean) => void> = new Map();

  constructor(
    private readonly deviceConnectionManager: DeviceConnectionManager,
    private readonly createSession: DeviceVoiceSessionFactory
  ) {}

  private getOrCreateSession(deviceId: string): DeviceVoiceSession {
    let session = this.sessions.get(deviceId);
    if (!session) {
      session = this.createSession(deviceId);
      this.sessions.set(deviceId, session);
    }
    return session;
  }

  /**
   * Asks a real yes/no question and waits for the device's next transcript
   * to answer it — the same real confirmation UX Telegram gets, instead of
   * the phone's auto-deny, since a paired device is a reliable
   * bidirectional channel. Only one confirmation can be pending per device
   * at a time; a new one silently replaces (and orphans) any prior
   * unanswered entry, which is fine because `ConfirmationService`'s own
   * timeout already resolves the caller waiting on that stale prompt.
   */
  async awaitConfirmation(deviceId: string, questionText: string): Promise<boolean> {
    const resultPromise = new Promise<boolean>((resolve) => {
      this.pendingConfirmations.set(deviceId, resolve);
    });
    this.sendReply(deviceId, questionText);
    return resultPromise;
  }

  /** Sends a spoken-back reply to a device. Throws if the device isn't currently connected. */
  sendReply(deviceId: string, text: string): void {
    const envelope = makeEnvelope("voice.reply", { text }, deviceId, randomUUID());
    this.deviceConnectionManager.send(deviceId, JSON.stringify(envelope));
  }

  /**
   * Handles one wake-word-triggered voice transcript. Never throws: a
   * brain/tool failure still gets a spoken-style error reply instead of a
   * silently dropped one, and a failure sending *that* is only logged, not
   * thrown, so it can never crash the WebSocket message handler.
   */
  async handleTranscript(deviceId: string, text: string, forcedLanguage?: string): Promise<void> {
    const pendingResolve = this.pendingConfirmations.get(deviceId);
    if (pendingResolve) {
      if (YES_PATTERN.test(text)) {
        this.pendingConfirmations.delete(deviceId);
        pendingResolve(true);
        this.trySendReply(deviceId, "Confirmed.");
        return;
      }
      if (NO_PATTERN.test(text)) {
        this.pendingConfirmations.delete(deviceId);
        pendingResolve(false);
        this.trySendReply(deviceId, "Cancelled.");
        return;
      }
      this.trySendReply(deviceId, "Please say yes or no.");
      return;
    }

    const session = this.getOrCreateSession(deviceId);
    try {
      const reply = await session.orchestrator.handleUserMessage(
        session.userId,
        applyLanguageDirective(text, forcedLanguage)
      );
      this.sendReply(deviceId, reply);
    } catch (error) {
      console.error(`[jarvis] voice transcript handling failed for device ${deviceId}:`, error);
      this.trySendReply(deviceId, ERROR_MESSAGE);
    }
  }

  private trySendReply(deviceId: string, text: string): void {
    try {
      this.sendReply(deviceId, text);
    } catch (error) {
      console.error(`[jarvis] voice reply send failed for device ${deviceId}:`, error);
    }
  }
}
