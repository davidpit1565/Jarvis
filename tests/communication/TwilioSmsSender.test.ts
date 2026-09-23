import { describe, test, expect, afterEach } from "bun:test";
import { TwilioSmsSender } from "@/communication/phone/TwilioSmsSender";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

describe("TwilioSmsSender", () => {
  test("POSTs To/From/Body with basic auth and returns the message sid", async () => {
    let capturedUrl: string | undefined;
    let capturedBody: URLSearchParams | undefined;
    let capturedAuth: string | undefined;
    global.fetch = (async (url: unknown, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = new URLSearchParams(init?.body as string);
      capturedAuth = (init?.headers as Record<string, string>)?.Authorization;
      return new Response(JSON.stringify({ sid: "SM123" }), { status: 201 });
    }) as unknown as typeof fetch;

    const sender = new TwilioSmsSender("AC123", "auth-token", "+15005550006");
    const result = await sender.sendSms("+15551234567", "hello there");

    expect(result).toEqual({ messageSid: "SM123" });
    expect(capturedUrl).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json");
    expect(capturedBody?.get("To")).toBe("+15551234567");
    expect(capturedBody?.get("From")).toBe("+15005550006");
    expect(capturedBody?.get("Body")).toBe("hello there");
    expect(capturedAuth).toBe(`Basic ${Buffer.from("AC123:auth-token").toString("base64")}`);
  });

  test("throws on a non-2xx response without leaking Twilio's raw response body (or the auth token)", async () => {
    global.fetch = (async () => new Response("bad number", { status: 400 })) as unknown as typeof fetch;

    const sender = new TwilioSmsSender("AC123", "auth-token", "+15005550006");
    let thrown: Error | undefined;
    try {
      await sender.sendSms("+1invalid", "hi");
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown?.message).toContain("400");
    expect(thrown?.message).not.toContain("bad number");
    expect(thrown?.message).not.toContain("auth-token");
  });
});
