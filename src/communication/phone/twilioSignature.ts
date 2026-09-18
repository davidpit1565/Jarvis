import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies Twilio's `X-Twilio-Signature` header per Twilio's documented
 * algorithm: base64(HMAC-SHA1(authToken, url + sorted-concatenated
 * "key" + "value" pairs from the POST body)). Without this check, anyone
 * who discovers the webhook URL could POST fake speech input and drive
 * JARVIS's tools (including SAVE_MEMORY) with no real phone call involved
 * — this is the only thing standing between "public URL" and "arbitrary
 * remote input to Claude's tool loop", so it is required, not optional,
 * wherever the phone gateway is wired up.
 */
export function verifyTwilioSignature(
  authToken: string,
  fullUrl: string,
  params: Record<string, string>,
  signatureHeader: string | null
): boolean {
  if (!signatureHeader) return false;

  const sortedKeys = Object.keys(params).sort();
  let data = fullUrl;
  for (const key of sortedKeys) {
    data += key + params[key];
  }

  const expected = createHmac("sha1", authToken).update(data, "utf8").digest("base64");

  const expectedBuffer = Buffer.from(expected, "utf8");
  const providedBuffer = Buffer.from(signatureHeader, "utf8");

  if (expectedBuffer.length !== providedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, providedBuffer);
}
