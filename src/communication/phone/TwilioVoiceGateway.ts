import type { Orchestrator } from "@/core/orchestrator/Orchestrator";

export interface PhoneSession {
  orchestrator: Orchestrator;
  userId: string;
}

/** Builds a fresh session (its own conversation, sharing everything else) for one phone call. */
export type PhoneSessionFactory = (callSid: string) => PhoneSession;

const GREETING_EN = "Hi, this is JARVIS. What can I help you with?";
const GREETING_HE = "שלום, כאן ג'רביס. במה אוכל לעזור?";
const NO_INPUT_EN = "Sorry, I didn't catch that. Could you say that again?";
const NO_INPUT_HE = "לא שמעתי. תוכל לחזור על זה?";
const ERROR_EN = "Sorry, something went wrong on my end. Please try again.";
const ERROR_HE = "משהו השתבש אצלי. נסה שוב בבקשה.";
const GOODBYE_EN = "I didn't hear anything. Goodbye.";
const GOODBYE_HE = "לא שמעתי כלום. להתראות.";
const CALL_LIMIT_EN = "This call has gone on for a while — let's continue over text. Goodbye for now.";
const CALL_LIMIT_HE = "השיחה הזו נמשכת כבר זמן רב — נמשיך בהודעות. להתראות בינתיים.";

/**
 * Caps how many back-and-forth turns a single phone call can have before
 * JARVIS ends it itself. Twilio bills call minutes and every turn is
 * another Anthropic API call — without a cap, one very long or automated
 * call (deliberate abuse, or just someone leaving the line open) could run
 * up real cost indefinitely with no natural end. Generous for an actual
 * conversation: nobody has 40 back-and-forth exchanges with JARVIS on the
 * phone in one sitting.
 */
const MAX_CALL_TURNS = 40;

/**
 * Amazon Polly's Neural voice for <Say> — noticeably more natural than
 * Twilio's default "Basic" voice, and (unlike Twilio's newer Generative
 * voices) available on standard accounts with no beta opt-in required.
 * Overridable via the TWILIO_VOICE env var if a better voice becomes
 * available on the account this actually runs on.
 */
const DEFAULT_VOICE = "Polly.Matthew-Neural";

/**
 * Google's WaveNet Hebrew voice — Polly has no Hebrew voice at all, so
 * Hebrew speech always goes through Twilio's Google TTS integration
 * regardless of what English voice is configured. Overridable via
 * TWILIO_VOICE_HEBREW for the same reason TWILIO_VOICE is overridable.
 */
const DEFAULT_HEBREW_VOICE = "Google.he-IL-Wavenet-D";

/**
 * Twilio's <Gather> only recognizes one language per request UNLESS you opt
 * into Gather's newest Deepgram model, which supports `language="multi"` —
 * true automatic Hebrew/English detection in a single request. This is a
 * genuine Twilio capability (confirmed against Twilio's own docs), not
 * guessed, but REQUIRES REAL VALIDATION: never exercised against a live
 * Twilio account, and `deepgram_nova-3` could in principle not be enabled
 * on every account. If it isn't, set TWILIO_GATHER_LANGUAGE to a single
 * BCP-47 code (e.g. "he-IL" or "en-US") to fall back to Twilio's older,
 * single-language recognition.
 */
const DEFAULT_GATHER_LANGUAGE = "multi";
const MULTI_LANGUAGE_SPEECH_MODEL = "deepgram_nova-3";

const HEBREW_CHARS = /[֐-׿]/;

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function twimlResponse(body: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, {
    headers: { "Content-Type": "text/xml" },
  });
}

/**
 * Handles Twilio's Voice webhooks so JARVIS can be reached by phone call.
 * Twilio performs speech-to-text (via <Gather input="speech">) and
 * text-to-speech (via <Say>) itself — this gateway doesn't need its own
 * STT/TTS for the phone channel; see src/types/voice.ts for the separate
 * provider-agnostic interfaces a future microphone-based flow would use.
 *
 * Each call gets its own conversation (via `createSession`) but shares
 * the same Brain, ToolRegistry, PermissionService, DeviceRegistry, and
 * DeviceConnectionManager as everything else in Core — the same JARVIS,
 * a fresh conversation thread per call.
 *
 * REQUIRES REAL VALIDATION: needs a real Twilio account, a phone number,
 * and a public URL (e.g. via ngrok in development) pointing at these
 * routes. Never built or run against a real Twilio account. The caller
 * (JarvisWebSocketServer) is responsible for verifying
 * `X-Twilio-Signature` before invoking these handlers — this class trusts
 * that it's only ever called with genuine Twilio requests.
 */
export class TwilioVoiceGateway {
  private sessions: Map<string, PhoneSession> = new Map();
  private turnCounts: Map<string, number> = new Map();
  private readonly voice: string;
  private readonly hebrewVoice: string;
  private readonly gatherLanguage: string;

  constructor(
    private readonly createSession: PhoneSessionFactory,
    voice: string = DEFAULT_VOICE,
    /**
     * When set, the `wss://` URL Twilio should stream raw call audio to
     * (see JarvisWebSocketServer's /voice/audio-stream). Included via
     * <Start><Stream> only on the initial greeting — the stream is
     * call-scoped, not per-TwiML-response, so it doesn't need repeating
     * on every gather turn. Unset means no audio waveform feature.
     */
    private readonly audioStreamUrl?: string,
    hebrewVoice: string = DEFAULT_HEBREW_VOICE,
    gatherLanguage: string = DEFAULT_GATHER_LANGUAGE
  ) {
    this.voice = voice;
    this.hebrewVoice = hebrewVoice;
    this.gatherLanguage = gatherLanguage;
  }

  /** One <Say>, in whichever voice fits the text's own language. */
  private sayTag(text: string): string {
    return HEBREW_CHARS.test(text)
      ? `<Say language="he-IL" voice="${escapeXml(this.hebrewVoice)}">${escapeXml(text)}</Say>`
      : `<Say voice="${escapeXml(this.voice)}">${escapeXml(text)}</Say>`;
  }

  /**
   * Two <Say> tags, Hebrew then English — used only for JARVIS's own canned
   * prompts (greeting, no-input, error), where the caller's language isn't
   * known yet. Once JARVIS has an actual reply from the brain, `sayTag`
   * speaks it in just the one language it was actually written in.
   */
  private sayBilingual(hebrew: string, english: string): string {
    return this.sayTag(hebrew) + this.sayTag(english);
  }

  /**
   * A <Gather> that speaks `spokenTwiml` (already-rendered <Say> tags),
   * listens for the caller's speech in Hebrew or English (Twilio does the
   * speech-to-text itself and posts the transcript back to /voice/gather),
   * and falls back to a goodbye if nothing was heard.
   */
  private gatherPrompt(spokenTwiml: string): string {
    const speechModelAttr =
      this.gatherLanguage === DEFAULT_GATHER_LANGUAGE ? ` speechModel="${MULTI_LANGUAGE_SPEECH_MODEL}"` : "";
    return (
      `<Gather input="speech" action="/voice/gather" method="POST" speechTimeout="auto" ` +
      `language="${escapeXml(this.gatherLanguage)}"${speechModelAttr}>` +
      spokenTwiml +
      `</Gather>` +
      this.sayBilingual(GOODBYE_HE, GOODBYE_EN)
    );
  }

  /** POST /voice/incoming — Twilio calls this when a call comes in. */
  handleIncomingCall(callSid: string): Response {
    this.sessions.set(callSid, this.createSession(callSid));
    const streamTag = this.audioStreamUrl
      ? `<Start><Stream url="${escapeXml(this.audioStreamUrl)}" track="both_tracks" /></Start>`
      : "";
    return twimlResponse(streamTag + this.gatherPrompt(this.sayBilingual(GREETING_HE, GREETING_EN)));
  }

  /** POST /voice/gather — Twilio calls this with the caller's transcribed speech. */
  async handleGather(callSid: string, speechResult: string | null): Promise<Response> {
    const session = this.sessions.get(callSid) ?? this.createSession(callSid);
    this.sessions.set(callSid, session);

    const turnCount = (this.turnCounts.get(callSid) ?? 0) + 1;
    this.turnCounts.set(callSid, turnCount);
    if (turnCount > MAX_CALL_TURNS) {
      return twimlResponse(this.sayBilingual(CALL_LIMIT_HE, CALL_LIMIT_EN) + `<Hangup/>`);
    }

    if (!speechResult || speechResult.trim() === "") {
      return twimlResponse(this.gatherPrompt(this.sayBilingual(NO_INPUT_HE, NO_INPUT_EN)));
    }

    let spokenTwiml: string;
    try {
      const responseText = await session.orchestrator.handleUserMessage(session.userId, speechResult);
      spokenTwiml = this.sayTag(responseText);
    } catch {
      spokenTwiml = this.sayBilingual(ERROR_HE, ERROR_EN);
    }

    return twimlResponse(this.gatherPrompt(spokenTwiml));
  }

  /** POST /voice/status — Twilio's call status callback; frees the session's memory once the call ends. */
  handleCallEnded(callSid: string): void {
    this.sessions.delete(callSid);
    this.turnCounts.delete(callSid);
  }

  hasActiveSession(callSid: string): boolean {
    return this.sessions.has(callSid);
  }
}
