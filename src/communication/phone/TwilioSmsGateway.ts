import type { Orchestrator } from "@/core/orchestrator/Orchestrator";

export interface SmsSession {
  orchestrator: Orchestrator;
  userId: string;
}

/** Builds a fresh session (its own conversation, sharing everything else) for one phone number, on first text. */
export type SmsSessionFactory = (fromNumber: string) => SmsSession;

const ERROR_MESSAGE = "Sorry, something went wrong on my end. Please try again.";

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function twiml(message: string): Response {
  const body = `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(message)}</Message></Response>`;
  return new Response(body, { headers: { "Content-Type": "text/xml" } });
}

const emptyTwiml = () => new Response(`<?xml version="1.0" encoding="UTF-8"?><Response/>`, { headers: { "Content-Type": "text/xml" } });

const MMS_NOT_SUPPORTED_MESSAGE =
  "Sorry, I can't view photos or attachments over text yet — try describing what's in it, or send it via Telegram instead.";

/**
 * A real texting channel — the same Twilio number the phone gateway
 * already answers calls on, reused for SMS at zero extra setup: no new
 * account, no new number, no new secret. Twilio's inbound SMS webhook is
 * request/response with a real timeout (Twilio gives up if it doesn't get
 * a reply in a few seconds), so a reply is the TwiML `<Message>` returned
 * synchronously from THIS SAME request — there is no way to hold this
 * request open and answer it from a *later* one the way Telegram's
 * webhook-plus-separate-sendMessage-call model can. That rules out a real
 * "wait for the next text to say yes/no" confirmation round trip here:
 * this channel's own session is built with a ConfirmationService that
 * auto-denies, exactly like the phone gateway (see denyPhoneConfirmation
 * in index.ts) — a CONFIRM/DANGEROUS tool just isn't reachable over SMS
 * rather than silently hanging until Twilio times the request out.
 *
 * Each phone number gets its own conversation thread, kept for the life
 * of the process — same model as Telegram (no natural "hang up" for text).
 */
export class TwilioSmsGateway {
  private sessions: Map<string, SmsSession> = new Map();

  constructor(private readonly createSession: SmsSessionFactory) {}

  private getOrCreateSession(fromNumber: string): SmsSession {
    let session = this.sessions.get(fromNumber);
    if (!session) {
      session = this.createSession(fromNumber);
      this.sessions.set(fromNumber, session);
    }
    return session;
  }

  /**
   * Handles one incoming SMS webhook (already signature-verified by the
   * caller) and returns the TwiML response Twilio expects. Never throws:
   * a brain/tool failure still gets a spoken-style error reply, and the
   * caller can always send this Response back to Twilio regardless of
   * what went wrong inside.
   */
  async handleIncomingSms(fromNumber: string, body: string, mediaCount = 0): Promise<Response> {
    const text = body.trim();
    if (text.length === 0) {
      // An MMS with only an attachment (a photo, no caption) arrives with
      // an empty Body — without this check that silently returned no
      // reply at all, the same "looks broken" failure mode just fixed for
      // Telegram's own photo/voice/document messages.
      if (mediaCount > 0) return twiml(MMS_NOT_SUPPORTED_MESSAGE);
      return emptyTwiml();
    }

    // A caption alongside media still only ever gives the model the
    // caption text — the image itself never reaches it — so the model is
    // told explicitly rather than risk it confidently describing an
    // attachment it never received.
    const messageForBrain =
      mediaCount > 0
        ? `${text}\n\n[The user also attached ${mediaCount} image(s)/file(s) over MMS, which are not visible to you.]`
        : text;

    const session = this.getOrCreateSession(fromNumber);
    try {
      const reply = await session.orchestrator.handleUserMessage(session.userId, messageForBrain);
      return twiml(reply);
    } catch (error) {
      console.error(`[jarvis] SMS message handling failed for ${fromNumber}:`, error);
      return twiml(ERROR_MESSAGE);
    }
  }
}
