const TWILIO_API_BASE_URL = "https://api.twilio.com/2010-04-01";

/**
 * Places an outbound call via Twilio's REST API — the counterpart to
 * TwilioVoiceGateway, which only ever *receives* calls. Used for JARVIS to
 * call the user (e.g. a scheduled wake-up call) rather than wait to be
 * called. Twilio hits `twimlUrl` once the call connects, the same way it
 * hits /voice/incoming for an inbound call, so the actual conversation
 * still flows through the existing phone-session/Orchestrator machinery.
 */
export class TwilioOutboundCaller {
  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly fromNumber: string
  ) {}

  /** Returns the new call's SID. Throws on a non-2xx response from Twilio. */
  async placeCall(toNumber: string, twimlUrl: string): Promise<{ callSid: string }> {
    const credentials = Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64");
    const body = new URLSearchParams({ To: toNumber, From: this.fromNumber, Url: twimlUrl });

    const response = await fetch(`${TWILIO_API_BASE_URL}/Accounts/${this.accountSid}/Calls.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (!response.ok) {
      // Twilio's error body can be genuinely useful for debugging a bad
      // number/config, but never includes the auth token itself — safe to
      // surface as-is.
      const detail = await response.text().catch(() => "");
      throw new Error(`Twilio outbound call failed (${response.status}): ${detail}`);
    }

    const data = (await response.json()) as { sid: string };
    return { callSid: data.sid };
  }
}
