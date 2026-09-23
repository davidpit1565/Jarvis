import { describe, test, expect, afterEach } from "bun:test";
import { TwilioOutboundCaller } from "@/communication/phone/TwilioOutboundCaller";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

describe("TwilioOutboundCaller", () => {
  test("places a call with the expected request shape and returns the call SID", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;

    global.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(JSON.stringify({ sid: "CA123" }), { status: 201 });
    }) as typeof fetch;

    const caller = new TwilioOutboundCaller("ACxxx", "authtoken", "+15005550006");
    const result = await caller.placeCall("+15551234567", "https://example.com/voice/wakeup-connected");

    expect(result.callSid).toBe("CA123");
    expect(capturedUrl).toBe("https://api.twilio.com/2010-04-01/Accounts/ACxxx/Calls.json");
    expect(capturedInit?.method).toBe("POST");

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("ACxxx:authtoken").toString("base64")}`);

    const body = new URLSearchParams(capturedInit?.body as string);
    expect(body.get("To")).toBe("+15551234567");
    expect(body.get("From")).toBe("+15005550006");
    expect(body.get("Url")).toBe("https://example.com/voice/wakeup-connected");
  });

  test("includes StatusCallback/StatusCallbackEvent when a status callback URL is given", async () => {
    let capturedInit: RequestInit | undefined;
    global.fetch = (async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      return new Response(JSON.stringify({ sid: "CA123" }), { status: 201 });
    }) as typeof fetch;

    const caller = new TwilioOutboundCaller("ACxxx", "authtoken", "+15005550006");
    await caller.placeCall("+15551234567", "https://example.com/voice/wakeup-connected", "https://example.com/voice/status");

    const body = new URLSearchParams(capturedInit?.body as string);
    expect(body.get("StatusCallback")).toBe("https://example.com/voice/status");
    expect(body.get("StatusCallbackEvent")).toBe("completed");
  });

  test("omits StatusCallback when no status callback URL is given", async () => {
    let capturedInit: RequestInit | undefined;
    global.fetch = (async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      return new Response(JSON.stringify({ sid: "CA123" }), { status: 201 });
    }) as typeof fetch;

    const caller = new TwilioOutboundCaller("ACxxx", "authtoken", "+15005550006");
    await caller.placeCall("+15551234567", "https://example.com/voice/wakeup-connected");

    const body = new URLSearchParams(capturedInit?.body as string);
    expect(body.get("StatusCallback")).toBeNull();
    expect(body.get("StatusCallbackEvent")).toBeNull();
  });

  test("throws with Twilio's error detail on a non-2xx response, without leaking the auth token", async () => {
    global.fetch = (async () => new Response("bad request detail", { status: 400 })) as unknown as typeof fetch;

    const caller = new TwilioOutboundCaller("ACxxx", "super-secret-token", "+15005550006");

    let error: Error | undefined;
    try {
      await caller.placeCall("+15551234567", "https://example.com/voice/wakeup-connected");
    } catch (e) {
      error = e as Error;
    }

    expect(error?.message).toContain("bad request detail");
    expect(error?.message).not.toContain("super-secret-token");
  });
});
