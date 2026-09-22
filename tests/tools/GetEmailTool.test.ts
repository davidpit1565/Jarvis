import { describe, test, expect, afterEach } from "bun:test";
import { CalendarTokenStore } from "@/calendar/CalendarTokenStore";
import { GmailClient } from "@/gmail/GmailClient";
import { createGetEmailTool } from "@/tools/gmail/GetEmailTool";
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

describe("GET_EMAIL tool", () => {
  test("is READ", () => {
    const tool = createGetEmailTool(makeClient());
    expect(tool.requiredPermission).toBe(PermissionLevel.READ);
  });

  test("requires a non-empty messageId", async () => {
    const tool = createGetEmailTool(makeClient());
    const result = await tool.execute({ messageId: "" }, context);
    expect(result.success).toBe(false);
  });

  test("returns the full body on success", async () => {
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          payload: {
            mimeType: "text/plain",
            body: { data: Buffer.from("full body text", "utf8").toString("base64url") },
            headers: [{ name: "Subject", value: "Hello" }, { name: "From", value: "bob@example.com" }],
          },
        }),
        { status: 200 }
      )) as unknown as typeof fetch;

    const tool = createGetEmailTool(makeClient());
    const result = await tool.execute({ messageId: "m1" }, context);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ subject: "Hello", from: "bob@example.com", date: "", body: "full body text", account: "me@example.com" });
  });

  test("returns a failure result (not a throw) when no account is linked", async () => {
    const unlinkedTokenStore = new CalendarTokenStore(":memory:");
    const client = new GmailClient("client-id", "client-secret", unlinkedTokenStore);
    const tool = createGetEmailTool(client);

    const result = await tool.execute({ messageId: "m1" }, context);
    expect(result.success).toBe(false);
    expect(result.error).toContain("No Google account linked");
  });
});
