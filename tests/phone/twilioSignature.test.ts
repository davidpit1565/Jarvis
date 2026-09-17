import { describe, test, expect } from "bun:test";
import { createHmac } from "node:crypto";
import { verifyTwilioSignature } from "@/communication/phone/twilioSignature";

const AUTH_TOKEN = "test-auth-token";
const URL = "https://example.ngrok.io/voice/incoming";

function signFor(authToken: string, url: string, params: Record<string, string>): string {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) data += key + params[key];
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

describe("verifyTwilioSignature", () => {
  test("accepts a correctly signed request", () => {
    const params = { CallSid: "CA123", From: "+15551234567" };
    const signature = signFor(AUTH_TOKEN, URL, params);

    expect(verifyTwilioSignature(AUTH_TOKEN, URL, params, signature)).toBe(true);
  });

  test("rejects a request signed with the wrong auth token", () => {
    const params = { CallSid: "CA123" };
    const signature = signFor("a-different-token", URL, params);

    expect(verifyTwilioSignature(AUTH_TOKEN, URL, params, signature)).toBe(false);
  });

  test("rejects a request whose params were tampered with after signing", () => {
    const originalParams = { CallSid: "CA123", SpeechResult: "what am I doing" };
    const signature = signFor(AUTH_TOKEN, URL, originalParams);

    const tamperedParams = { ...originalParams, SpeechResult: "delete everything" };

    expect(verifyTwilioSignature(AUTH_TOKEN, URL, tamperedParams, signature)).toBe(false);
  });

  test("rejects a request signed for a different URL", () => {
    const params = { CallSid: "CA123" };
    const signature = signFor(AUTH_TOKEN, URL, params);

    expect(verifyTwilioSignature(AUTH_TOKEN, "https://example.ngrok.io/voice/gather", params, signature)).toBe(
      false
    );
  });

  test("rejects a missing signature", () => {
    expect(verifyTwilioSignature(AUTH_TOKEN, URL, { CallSid: "CA123" }, null)).toBe(false);
  });

  test("rejects an empty-string signature", () => {
    expect(verifyTwilioSignature(AUTH_TOKEN, URL, { CallSid: "CA123" }, "")).toBe(false);
  });

  test("works with no params at all", () => {
    const signature = signFor(AUTH_TOKEN, URL, {});
    expect(verifyTwilioSignature(AUTH_TOKEN, URL, {}, signature)).toBe(true);
  });
});
