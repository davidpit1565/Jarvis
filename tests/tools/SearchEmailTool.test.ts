import { describe, test, expect, afterEach } from "bun:test";
import { CalendarTokenStore } from "@/calendar/CalendarTokenStore";
import { GmailClient } from "@/gmail/GmailClient";
import { createSearchEmailTool } from "@/tools/gmail/SearchEmailTool";
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

describe("SEARCH_EMAIL tool", () => {
  test("is READ", () => {
    const tool = createSearchEmailTool(makeClient());
    expect(tool.requiredPermission).toBe(PermissionLevel.READ);
  });

  test("requires a non-empty query", async () => {
    const tool = createSearchEmailTool(makeClient());
    const result = await tool.execute({ query: "" }, context);
    expect(result.success).toBe(false);
  });

  test("rejects an invalid maxResults", async () => {
    const tool = createSearchEmailTool(makeClient());
    const result = await tool.execute({ query: "is:unread", maxResults: -1 }, context);
    expect(result.success).toBe(false);
  });

  test("returns matching messages on success", async () => {
    global.fetch = (async (url: string) => {
      if (url.includes("/messages?")) {
        return new Response(JSON.stringify({ messages: [{ id: "m1" }] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          id: "m1",
          snippet: "Hi there",
          payload: { headers: [{ name: "Subject", value: "Hello" }, { name: "From", value: "bob@example.com" }] },
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const tool = createSearchEmailTool(makeClient());
    const result = await tool.execute({ query: "from:bob" }, context);

    expect(result.success).toBe(true);
    expect((result.data as { messages: unknown[] }).messages).toHaveLength(1);
  });

  test("returns a failure result (not a throw) when no account is linked", async () => {
    const unlinkedTokenStore = new CalendarTokenStore(":memory:");
    const client = new GmailClient("client-id", "client-secret", unlinkedTokenStore);
    const tool = createSearchEmailTool(client);

    const result = await tool.execute({ query: "is:unread" }, context);
    expect(result.success).toBe(false);
    expect(result.error).toContain("No Google account linked");
  });
});
