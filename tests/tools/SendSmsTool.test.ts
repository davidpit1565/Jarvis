import { describe, test, expect, afterEach } from "bun:test";
import { TwilioSmsSender } from "@/communication/phone/TwilioSmsSender";
import { createSendSmsTool } from "@/tools/phone/SendSmsTool";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function makeSender() {
  return new TwilioSmsSender("AC123", "auth-token", "+15005550006");
}

describe("SEND_SMS tool", () => {
  test("is SAFE_ACTION", () => {
    const tool = createSendSmsTool(makeSender(), "+15551234567");
    expect(tool.requiredPermission).toBe(PermissionLevel.SAFE_ACTION);
  });

  test("rejects an empty message", async () => {
    const tool = createSendSmsTool(makeSender(), "+15551234567");
    const result = await tool.execute({ message: "" }, context);
    expect(result.success).toBe(false);
  });

  test("always sends to the configured owner number, ignoring any other destination", async () => {
    let capturedTo: string | undefined;
    global.fetch = (async (_url: unknown, init?: RequestInit) => {
      capturedTo = new URLSearchParams(init?.body as string).get("To") ?? undefined;
      return new Response(JSON.stringify({ sid: "SM1" }), { status: 201 });
    }) as unknown as typeof fetch;

    const tool = createSendSmsTool(makeSender(), "+15551234567");
    const result = await tool.execute({ message: "hi there" }, context);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ messageSid: "SM1" });
    expect(capturedTo).toBe("+15551234567");
  });

  test("returns a failure result (not a throw) when Twilio rejects the send", async () => {
    global.fetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;

    const tool = createSendSmsTool(makeSender(), "+15551234567");
    const result = await tool.execute({ message: "hi" }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain("500");
  });
});
