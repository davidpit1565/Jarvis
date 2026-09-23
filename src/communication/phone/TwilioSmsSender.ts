import { apiError } from "@/core/net/apiError";

const TWILIO_API_BASE_URL = "https://api.twilio.com/2010-04-01";

/**
 * Sends an outbound SMS via Twilio's REST API — same account/credentials
 * as TwilioOutboundCaller (the wake-up-call placer), just a different
 * Twilio endpoint. A second real "reach the phone" channel alongside
 * Telegram: official, Twilio-billed per message, no ToS risk (unlike an
 * unofficial WhatsApp automation would be).
 */
export class TwilioSmsSender {
  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly fromNumber: string
  ) {}

  /** Returns the new message's SID. Throws on a non-2xx response from Twilio. */
  async sendSms(toNumber: string, body: string): Promise<{ messageSid: string }> {
    const credentials = Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64");
    const form = new URLSearchParams({ To: toNumber, From: this.fromNumber, Body: body });

    const response = await fetch(`${TWILIO_API_BASE_URL}/Accounts/${this.accountSid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });

    if (!response.ok) {
      throw await apiError("Twilio SMS send failed", response);
    }

    const data = (await response.json()) as { sid: string };
    return { messageSid: data.sid };
  }
}
