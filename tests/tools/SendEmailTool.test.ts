import { describe, test, expect, afterEach } from "bun:test";
import { CalendarTokenStore } from "@/calendar/CalendarTokenStore";
import { GmailClient } from "@/gmail/GmailClient";
import { createSendEmailTool } from "@/tools/gmail/SendEmailTool";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function makeClient() {
  const tokenStore = new CalendarTokenStore(":memory:");
  tokenStore.save("me@example.com", { refreshToken: "r1", accessToken: "a1", accessTokenExpiresAt: Date.now() + 3_600_000 });
  return new GmailClient("client-id", "client-secret", tokenStore);
}

describe("SEND_EMAIL tool", () => {
  test("is CONFIRM — a prompt-injected email body could otherwise trigger a silent send", () => {
    const tool = createSendEmailTool(makeClient());
    expect(tool.requiredPermission).toBe(PermissionLevel.CONFIRM);
  });

  test("rejects an invalid recipient", async () => {
    const tool = createSendEmailTool(makeClient());
    const result = await tool.execute({ to: "not-an-email", subject: "Hi", body: "Hello" }, context);
    expect(result.success).toBe(false);
  });

  test("rejects an empty subject", async () => {
    const tool = createSendEmailTool(makeClient());
    const result = await tool.execute({ to: "bob@example.com", subject: "", body: "Hello" }, context);
    expect(result.success).toBe(false);
  });

  test("rejects an empty body", async () => {
    const tool = createSendEmailTool(makeClient());
    const result = await tool.execute({ to: "bob@example.com", subject: "Hi", body: "" }, context);
    expect(result.success).toBe(false);
  });

  test("sends via the Gmail API and returns the new message id", async () => {
    let capturedBody: unknown;
    global.fetch = (async (_url: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse((init as RequestInit).body as string);
      return new Response(JSON.stringify({ id: "sent-1" }), { status: 200 });
    }) as unknown as typeof fetch;

    const tool = createSendEmailTool(makeClient());
    const result = await tool.execute({ to: "bob@example.com", subject: "Hi", body: "Hello there" }, context);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ messageId: "sent-1", to: "bob@example.com", subject: "Hi", account: "me@example.com" });
    const raw = Buffer.from((capturedBody as { raw: string }).raw, "base64url").toString("utf8");
    expect(raw).toContain("To: bob@example.com");
    expect(raw).toContain("Subject: Hi");
    expect(raw).toContain("Hello there");
  });

  test("strips CR/LF from to/subject to prevent header injection", async () => {
    let capturedBody: unknown;
    global.fetch = (async (_url: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse((init as RequestInit).body as string);
      return new Response(JSON.stringify({ id: "sent-2" }), { status: 200 });
    }) as unknown as typeof fetch;

    const tool = createSendEmailTool(makeClient());
    const result = await tool.execute(
      { to: "bob@example.com", subject: "Hi\r\nBcc: evil@example.com", body: "Hello" },
      context
    );

    expect(result.success).toBe(true);
    const raw = Buffer.from((capturedBody as { raw: string }).raw, "base64url").toString("utf8");
    // The injected text survives as inert content inside the Subject
    // header's value (correctly neutralized) — what must never happen is
    // it becoming its OWN header line, which would require a real CRLF.
    expect(raw).not.toContain("\r\nBcc:");
    expect(raw).toContain("Subject: Hi Bcc: evil@example.com");
  });

  test("returns a failure result (not a throw) on a Gmail API error", async () => {
    global.fetch = (async () => new Response("insufficient scope", { status: 403 })) as unknown as typeof fetch;

    const tool = createSendEmailTool(makeClient());
    const result = await tool.execute({ to: "bob@example.com", subject: "Hi", body: "Hello" }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain("403");
  });
});
