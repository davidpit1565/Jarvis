import type { Orchestrator } from "@/core/orchestrator/Orchestrator";

export interface PhoneSession {
  orchestrator: Orchestrator;
  userId: string;
}

/** Builds a fresh session (its own conversation, sharing everything else) for one phone call. */
export type PhoneSessionFactory = (callSid: string) => PhoneSession;

const GREETING = "Hi, this is JARVIS. What can I help you with?";
const NO_INPUT_MESSAGE = "Sorry, I didn't catch that. Could you say that again?";
const ERROR_MESSAGE = "Sorry, something went wrong on my end. Please try again.";

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
 * A <Gather> that speaks `sayText`, listens for the caller's speech (Twilio
 * does the speech-to-text itself and posts the transcript back to
 * /voice/gather), and falls back to a goodbye if nothing was heard.
 */
function gatherPrompt(sayText: string): string {
  return (
    `<Gather input="speech" action="/voice/gather" method="POST" speechTimeout="auto" language="en-US">` +
    `<Say>${escapeXml(sayText)}</Say>` +
    `</Gather>` +
    `<Say>I didn't hear anything. Goodbye.</Say>`
  );
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

  constructor(private readonly createSession: PhoneSessionFactory) {}

  /** POST /voice/incoming — Twilio calls this when a call comes in. */
  handleIncomingCall(callSid: string): Response {
    this.sessions.set(callSid, this.createSession(callSid));
    return twimlResponse(gatherPrompt(GREETING));
  }

  /** POST /voice/gather — Twilio calls this with the caller's transcribed speech. */
  async handleGather(callSid: string, speechResult: string | null): Promise<Response> {
    const session = this.sessions.get(callSid) ?? this.createSession(callSid);
    this.sessions.set(callSid, session);

    if (!speechResult || speechResult.trim() === "") {
      return twimlResponse(gatherPrompt(NO_INPUT_MESSAGE));
    }

    let responseText: string;
    try {
      responseText = await session.orchestrator.handleUserMessage(session.userId, speechResult);
    } catch {
      responseText = ERROR_MESSAGE;
    }

    return twimlResponse(gatherPrompt(responseText));
  }

  /** POST /voice/status — Twilio's call status callback; frees the session's memory once the call ends. */
  handleCallEnded(callSid: string): void {
    this.sessions.delete(callSid);
  }

  hasActiveSession(callSid: string): boolean {
    return this.sessions.has(callSid);
  }
}
