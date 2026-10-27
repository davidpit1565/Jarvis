import { randomUUID } from "node:crypto";
import { makeEnvelope, type ProactiveReplyPayload } from "@/communication/websocket/protocol";
import type { DeviceConnectionManager } from "@/communication/websocket/DeviceConnectionManager";
import type { SpeakerAuthenticator } from "@/core/confirmation/SpeakerAuthenticator";

/** How long (ms) beyond the device's own reply window Core waits before giving up on a `proactive.reply` — pure network/processing slack. */
const REPLY_GRACE_MS = 5_000;

export interface ProactiveAnnounceResult {
  /** Whether anything at all was heard during the reply window. */
  responded: boolean;
  /** Whether what was heard authenticated as the owner (see SpeakerAuthenticator). Always false when `responded` is false. */
  authenticated: boolean;
  /** Exactly what was heard, or null if nothing was (timeout, or the device never replied). */
  replyText: string | null;
}

/**
 * Sends an unprompted, JARVIS-initiated spoken announcement to a connected
 * device (`proactive.announce` — see protocol.ts) and resolves once the
 * device's `proactive.reply` comes back, times out, or the send itself
 * fails. Distinct from `DeviceVoiceGateway.awaitConfirmation`: that method
 * answers a question *within* a conversation the user already started;
 * this one starts the conversation on JARVIS's own initiative, so whatever
 * comes back must go through `SpeakerAuthenticator` before being trusted
 * as really the owner (see that interface's own doc comment for why).
 *
 * Used by the reminder scheduler (index.ts) for `announce` reminders and
 * their bounded follow-ups (see getAnnounceFollowUps) — never for a normal
 * device-voice conversational turn.
 */
export class ProactiveAnnouncer {
  private pending: Map<string, (result: ProactiveAnnounceResult) => void> = new Map();

  constructor(
    private readonly deviceConnectionManager: DeviceConnectionManager,
    private readonly authenticator: SpeakerAuthenticator
  ) {}

  /**
   * Speaks `text` on `deviceId` and waits up to `replyWindowMs` (plus a
   * small network grace period) for a reply. Never throws: a send failure
   * (device disconnected between target resolution and this call) resolves
   * the same way a timeout does — "nothing came back" — since the caller's
   * own fallback (push/Telegram) is the right response either way, not a
   * thrown error.
   */
  announce(deviceId: string, text: string, replyWindowMs: number): Promise<ProactiveAnnounceResult> {
    const announcementId = randomUUID();
    const envelope = makeEnvelope("proactive.announce", { text, announcementId, replyWindowMs }, deviceId, randomUUID());

    return new Promise<ProactiveAnnounceResult>((resolve) => {
      let settled = false;
      const settle = (result: ProactiveAnnounceResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pending.delete(announcementId);
        resolve(result);
      };

      const timer = setTimeout(() => {
        settle({ responded: false, authenticated: false, replyText: null });
      }, replyWindowMs + REPLY_GRACE_MS);

      this.pending.set(announcementId, (result) => settle(result));

      try {
        this.deviceConnectionManager.send(deviceId, JSON.stringify(envelope));
      } catch {
        settle({ responded: false, authenticated: false, replyText: null });
      }
    });
  }

  /**
   * Feeds a device's `proactive.reply` back into the matching pending
   * `announce()` call. An `announcementId` with no pending entry (stale,
   * duplicate, or already timed out) is ignored rather than throwing —
   * same posture as `DeviceConnectionManager.handleToolResult`.
   */
  handleReply(deviceId: string, payload: ProactiveReplyPayload): void {
    const resolve = this.pending.get(payload.announcementId);
    if (!resolve) return;

    if (payload.text === null) {
      resolve({ responded: false, authenticated: false, replyText: null });
      return;
    }

    const authResult = this.authenticator.authenticate({ deviceId, text: payload.text });
    resolve({ responded: true, authenticated: authResult.authenticated, replyText: payload.text });
  }
}
