import { apiError } from "@/core/net/apiError";

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

  /**
   * Returns the new call's SID. Throws on a non-2xx response from Twilio.
   *
   * `statusCallbackUrl`, when given, is passed as Twilio's StatusCallback —
   * without it, Twilio never notifies this process when an API-placed call
   * ends (unlike an inbound call, which always hits the number's configured
   * status-changes webhook). Without a status callback,
   * TwilioVoiceGateway's per-call session/turnCount entries for this call
   * would never be cleaned up, leaking for the life of the process.
   */
  async placeCall(toNumber: string, twimlUrl: string, statusCallbackUrl?: string): Promise<{ callSid: string }> {
    const credentials = Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64");
    const bodyParams: Record<string, string> = { To: toNumber, From: this.fromNumber, Url: twimlUrl };
    if (statusCallbackUrl) {
      bodyParams.StatusCallback = statusCallbackUrl;
      bodyParams.StatusCallbackEvent = "completed";
    }
    const body = new URLSearchParams(bodyParams);

    const response = await fetch(`${TWILIO_API_BASE_URL}/Accounts/${this.accountSid}/Calls.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (!response.ok) {
      throw await apiError("Twilio outbound call failed", response);
    }

    const data = (await response.json()) as { sid: string };
    return { callSid: data.sid };
  }
}
