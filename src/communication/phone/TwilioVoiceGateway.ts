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
const WAKEUP_FALLBACK_EN = "Good morning! Time to wake up.";
const WAKEUP_FALLBACK_HE = "בוקר טוב! הגיע הזמן לקום.";
/**
 * What kicks off a wake-up call's conversation — sent to the Orchestrator
 * as if it were a user turn, so Claude generates the actual spoken
 * greeting itself (personalized from real reminders/memory context) rather
 * than JARVIS always saying the same canned line every single morning.
 */
const WAKEUP_TRIGGER_MESSAGE =
  "(This is a scheduled wake-up call JARVIS just placed. Open the conversation now: greet the user, tell " +
  "them it's time to get up, and give one real, specific, motivating reason from what you actually know " +
  "about today. Keep it short and energetic, spoken aloud on a phone call.)";
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
 * Amazon Polly's *Neural* engine for <Say> — reversed from an earlier
 * decision (Polly's Standard engine) that deliberately went for a
 * synthetic, distinct-machine/AI sound. That's no longer what's wanted:
 * the voice should read as a real, natural human, not "AI-ish." Neural
 * voices are Polly's most natural-sounding tier — this is the direct
 * opposite tradeoff from the Standard choice's own reasoning. Overridable
 * via the TWILIO_VOICE env var if a different voice sounds better on the
 * account this actually runs on — REQUIRES REAL VALIDATION, never
 * exercised against a live Twilio account (Twilio isn't configured yet).
 */
const DEFAULT_VOICE = "Polly.Matthew-Neural";

/**
 * Google's *WaveNet* Hebrew voice — Polly has no Hebrew voice at all, so
 * Hebrew speech always goes through Twilio's Google TTS integration
 * regardless of what English voice is configured. WaveNet (not Standard)
 * for the same "sound like a real person" reason DEFAULT_VOICE is now
 * Polly's Neural engine. Overridable via TWILIO_VOICE_HEBREW.
 */
const DEFAULT_HEBREW_VOICE = "Google.he-IL-Wavenet-C";

/**
 * SSML <prosody> applied around every spoken line. Neutral now (no pitch
 * lowering, natural pace) — the previous deliberately-lowered/slowed
 * values existed specifically to sound more synthetic, which is exactly
 * what's no longer wanted. AWS Neural voices only honor `<prosody rate>`
 * over SSML, not `<prosody pitch>` (silently ignored), so pitch is left
 * at its neutral default rather than removed outright — harmless on
 * Neural, and still meaningful for the Hebrew Google WaveNet voice, which
 * does honor it. Overridable via TWILIO_VOICE_PITCH / TWILIO_VOICE_RATE.
 */
const DEFAULT_VOICE_PITCH = "0%";
const DEFAULT_VOICE_RATE = "100%";

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
/**
 * How long a callSid stays remembered as "already ended" after
 * handleCallEnded fires. Twilio's call-status and speech-gather webhooks
 * for the same call are independent HTTP requests with no ordering
 * guarantee — if status arrives first, a /voice/gather that lands
 * immediately after would otherwise find nothing in `sessions` and
 * recreate one via the "not started yet" fallback, leaking a fresh
 * Orchestrator/conversation forever (no further /voice/status will ever
 * arrive for a call that's already over to clean it up). Ten minutes is
 * comfortably longer than any plausible webhook race, while still
 * bounding this map's growth to "calls that ended in the last 10
 * minutes" rather than every call this process has ever handled.
 */
const ENDED_CALL_TOMBSTONE_TTL_MS = 10 * 60 * 1000;

export class TwilioVoiceGateway {
  private sessions: Map<string, PhoneSession> = new Map();
  private turnCounts: Map<string, number> = new Map();
  private endedCallSids: Map<string, number> = new Map();
  private readonly voice: string;
  private readonly hebrewVoice: string;
  private readonly gatherLanguage: string;
  private readonly voicePitch: string;
  private readonly voiceRate: string;

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
    gatherLanguage: string = DEFAULT_GATHER_LANGUAGE,
    /**
     * Builds the session for an outbound wake-up call — separate from
     * `createSession` so it can carry a distinct `channelContext` telling
     * Claude this is a call JARVIS itself placed, not one it answered.
     * Falls back to `createSession` when omitted (the wake-up feature
     * still works, just without that extra framing).
     */
    private readonly createWakeUpSession: PhoneSessionFactory = createSession,
    voicePitch: string = DEFAULT_VOICE_PITCH,
    voiceRate: string = DEFAULT_VOICE_RATE
  ) {
    this.voice = voice;
    this.hebrewVoice = hebrewVoice;
    this.gatherLanguage = gatherLanguage;
    this.voicePitch = voicePitch;
    this.voiceRate = voiceRate;
  }

  /** One <Say>, in whichever voice fits the text's own language, pitched down for a machine-like tone. */
  private sayTag(text: string): string {
    const prosody = `<prosody pitch="${escapeXml(this.voicePitch)}" rate="${escapeXml(this.voiceRate)}">${escapeXml(text)}</prosody>`;
    return HEBREW_CHARS.test(text)
      ? `<Say language="he-IL" voice="${escapeXml(this.hebrewVoice)}">${prosody}</Say>`
      : `<Say voice="${escapeXml(this.voice)}">${prosody}</Say>`;
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
    // Twilio CallSids are globally unique and never reused in practice,
    // but clearing any stale tombstone here is cheap defense-in-depth
    // against ever mistaking this brand-new, genuinely active call for a
    // late /voice/gather race against a call that already ended.
    this.endedCallSids.delete(callSid);
    this.sessions.set(callSid, this.createSession(callSid));
    const streamTag = this.audioStreamUrl
      ? `<Start><Stream url="${escapeXml(this.audioStreamUrl)}" track="both_tracks" /></Start>`
      : "";
    return twimlResponse(streamTag + this.gatherPrompt(this.sayBilingual(GREETING_HE, GREETING_EN)));
  }

  /**
   * Twilio calls this once an outbound wake-up call is answered (see
   * TwilioOutboundCaller.placeCall's `twimlUrl`). Unlike handleIncomingCall,
   * JARVIS speaks first: it asks its own brain for an opening line (so the
   * greeting is personalized from real reminders/memory context, not a
   * fixed canned sentence) before gathering the user's spoken reply. Once
   * the session is created, every following /voice/gather POST for this
   * callSid finds it in `this.sessions` exactly like an inbound call would.
   */
  async handleWakeUpCallConnected(callSid: string): Promise<Response> {
    this.endedCallSids.delete(callSid);
    const session = this.createWakeUpSession(callSid);
    this.sessions.set(callSid, session);

    let spokenTwiml: string;
    try {
      const responseText = await session.orchestrator.handleUserMessage(session.userId, WAKEUP_TRIGGER_MESSAGE);
      spokenTwiml = this.sayTag(responseText);
    } catch {
      spokenTwiml = this.sayBilingual(WAKEUP_FALLBACK_HE, WAKEUP_FALLBACK_EN);
    }

    return twimlResponse(this.gatherPrompt(spokenTwiml));
  }

  /** POST /voice/gather — Twilio calls this with the caller's transcribed speech. */
  async handleGather(callSid: string, speechResult: string | null): Promise<Response> {
    if (this.endedCallSids.has(callSid)) {
      // The call's /voice/status webhook already fired for this callSid —
      // recreating a session here would leak a brand-new
      // Orchestrator/conversation forever, since the call is over and no
      // further /voice/status will ever arrive to clean it up.
      return twimlResponse(`<Hangup/>`);
    }

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

    const now = Date.now();
    this.endedCallSids.set(callSid, now);
    // Opportunistic sweep, same pattern as RateLimiter.maybeSweep — bounds
    // this map to calls that ended within the TTL window instead of every
    // call this process has ever handled.
    for (const [sid, endedAt] of this.endedCallSids) {
      if (now - endedAt > ENDED_CALL_TOMBSTONE_TTL_MS) this.endedCallSids.delete(sid);
    }
  }

  hasActiveSession(callSid: string): boolean {
    return this.sessions.has(callSid);
  }
}
