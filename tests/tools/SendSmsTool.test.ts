import { describe, test, expect, afterEach } from "bun:test";
import { TwilioSmsSender } from "@/communication/phone/TwilioSmsSender";
import { TwilioCostGuard } from "@/communication/phone/TwilioCostGuard";
import { createSendSmsTool } from "@/tools/phone/SendSmsTool";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };
const originalFetch = global.fetch;
const fixedDateKey = () => "2026-01-01";

afterEach(() => {
  global.fetch = originalFetch;
});

function makeSender() {
  return new TwilioSmsSender("AC123", "auth-token", "+15005550006");
}

describe("SEND_SMS tool", () => {
  test("is SAFE_ACTION", () => {
    const tool = createSendSmsTool(makeSender(), "+15551234567", new TwilioCostGuard(20), fixedDateKey);
    expect(tool.requiredPermission).toBe(PermissionLevel.SAFE_ACTION);
  });

  test("rejects an empty message", async () => {
    const tool = createSendSmsTool(makeSender(), "+15551234567", new TwilioCostGuard(20), fixedDateKey);
    const result = await tool.execute({ message: "" }, context);
    expect(result.success).toBe(false);
  });

  test("rejects a message over the length cap", async () => {
    const tool = createSendSmsTool(makeSender(), "+15551234567", new TwilioCostGuard(20), fixedDateKey);
    const result = await tool.execute({ message: "x".repeat(1601) }, context);
    expect(result.success).toBe(false);
    expect(result.error).toContain("too long");
  });

  test("always sends to the configured owner number, ignoring any other destination", async () => {
    let capturedTo: string | undefined;
    global.fetch = (async (_url: unknown, init?: RequestInit) => {
      capturedTo = new URLSearchParams(init?.body as string).get("To") ?? undefined;
      return new Response(JSON.stringify({ sid: "SM1" }), { status: 201 });
    }) as unknown as typeof fetch;

    const tool = createSendSmsTool(makeSender(), "+15551234567", new TwilioCostGuard(20), fixedDateKey);
    const result = await tool.execute({ message: "hi there" }, context);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ messageSid: "SM1" });
    expect(capturedTo).toBe("+15551234567");
  });

  test("returns a failure result (not a throw) when Twilio rejects the send", async () => {
    global.fetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;

    const tool = createSendSmsTool(makeSender(), "+15551234567", new TwilioCostGuard(20), fixedDateKey);
    const result = await tool.execute({ message: "hi" }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain("500");
  });

  test("enforces the daily send cap, blocking further sends once reached", async () => {
    global.fetch = (async () => new Response(JSON.stringify({ sid: "SM1" }), { status: 201 })) as unknown as typeof fetch;

    const guard = new TwilioCostGuard(1);
    const tool = createSendSmsTool(makeSender(), "+15551234567", guard, fixedDateKey);

    const first = await tool.execute({ message: "hi" }, context);
    expect(first.success).toBe(true);

    const second = await tool.execute({ message: "hi again" }, context);
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/daily sms send limit/i);
  });

  test("never consumes the daily cap on a validation failure", async () => {
    const guard = new TwilioCostGuard(1);
    const tool = createSendSmsTool(makeSender(), "+15551234567", guard, fixedDateKey);

    await tool.execute({ message: "" }, context);

    expect(guard.remaining(fixedDateKey())).toBe(1);
  });

  test("refunds the consumed slot when Twilio rejects the send, so a transient failure doesn't burn quota", async () => {
    global.fetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;

    const guard = new TwilioCostGuard(1);
    const tool = createSendSmsTool(makeSender(), "+15551234567", guard, fixedDateKey);

    const result = await tool.execute({ message: "hi" }, context);

    expect(result.success).toBe(false);
    expect(guard.remaining(fixedDateKey())).toBe(1);
  });
});
