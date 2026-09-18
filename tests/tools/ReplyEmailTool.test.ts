import { describe, test, expect, afterEach } from "bun:test";
import { CalendarTokenStore } from "@/calendar/CalendarTokenStore";
import { GmailClient } from "@/gmail/GmailClient";
import { createReplyEmailTool } from "@/tools/gmail/ReplyEmailTool";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function makeClient() {
  const tokenStore = new CalendarTokenStore(":memory:");
  tokenStore.save({ refreshToken: "r1", accessToken: "a1", accessTokenExpiresAt: Date.now() + 3_600_000 });
  return new GmailClient("client-id", "client-secret", tokenStore);
}

describe("REPLY_EMAIL tool", () => {
  test("is CONFIRM — replying to an original sender who injected the request could otherwise exfiltrate data", () => {
    const tool = createReplyEmailTool(makeClient());
    expect(tool.requiredPermission).toBe(PermissionLevel.CONFIRM);
  });

  test("rejects an empty messageId", async () => {
    const tool = createReplyEmailTool(makeClient());
    const result = await tool.execute({ messageId: "", body: "Sure, sounds good" }, context);
    expect(result.success).toBe(false);
  });

  test("rejects an empty body", async () => {
    const tool = createReplyEmailTool(makeClient());
    const result = await tool.execute({ messageId: "m1", body: "" }, context);
    expect(result.success).toBe(false);
  });

  test("fetches the original message, derives recipient/subject/threading, and sends", async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    global.fetch = (async (url: unknown, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/messages/m1")) {
        return new Response(
          JSON.stringify({
            threadId: "thread-1",
            payload: {
              headers: [
                { name: "From", value: "alice@example.com" },
                { name: "Subject", value: "Project update" },
                { name: "Message-ID", value: "<orig@example.com>" },
              ],
            },
          }),
          { status: 200 }
        );
      }
      calls.push({ url: urlStr, body: init ? JSON.parse((init as RequestInit).body as string) : undefined });
      return new Response(JSON.stringify({ id: "reply-1" }), { status: 200 });
    }) as unknown as typeof fetch;

    const tool = createReplyEmailTool(makeClient());
    const result = await tool.execute({ messageId: "m1", body: "Sounds good!" }, context);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ messageId: "reply-1", inReplyTo: "m1" });
    expect(calls).toHaveLength(1);
    const sendBody = calls[0]!.body as { raw: string; threadId: string };
    expect(sendBody.threadId).toBe("thread-1");
    const raw = Buffer.from(sendBody.raw, "base64url").toString("utf8");
    expect(raw).toContain("To: alice@example.com");
    expect(raw).toContain("Subject: Re: Project update");
    expect(raw).toContain("In-Reply-To: <orig@example.com>");
    expect(raw).toContain("Sounds good!");
  });

  test("does not double-prefix a subject that already starts with Re:", async () => {
    let sendBody: { raw: string } | undefined;
    global.fetch = (async (url: unknown, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/messages/m1")) {
        return new Response(
          JSON.stringify({
            threadId: "thread-1",
            payload: { headers: [{ name: "From", value: "alice@example.com" }, { name: "Subject", value: "Re: Project update" }] },
          }),
          { status: 200 }
        );
      }
      sendBody = JSON.parse((init as RequestInit).body as string);
      return new Response(JSON.stringify({ id: "reply-2" }), { status: 200 });
    }) as unknown as typeof fetch;

    const tool = createReplyEmailTool(makeClient());
    await tool.execute({ messageId: "m1", body: "Ok" }, context);

    const raw = Buffer.from(sendBody!.raw, "base64url").toString("utf8");
    expect(raw).toContain("Subject: Re: Project update");
    expect(raw).not.toContain("Re: Re:");
  });

  test("returns a failure result when the original message has no From header", async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ threadId: "thread-1", payload: { headers: [] } }), { status: 200 })) as unknown as typeof fetch;

    const tool = createReplyEmailTool(makeClient());
    const result = await tool.execute({ messageId: "m1", body: "Ok" }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain("sender");
  });
});
