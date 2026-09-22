import { describe, test, expect, afterEach } from "bun:test";
import { CalendarTokenStore } from "@/calendar/CalendarTokenStore";
import { GmailClient } from "@/gmail/GmailClient";
import { createGetUnreadEmailCountTool } from "@/tools/gmail/GetUnreadEmailCountTool";
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

describe("GET_UNREAD_EMAIL_COUNT tool", () => {
  test("is READ", () => {
    const tool = createGetUnreadEmailCountTool(makeClient());
    expect(tool.requiredPermission).toBe(PermissionLevel.READ);
  });

  test("returns the unread count on success", async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ resultSizeEstimate: 3 }), { status: 200 })) as unknown as typeof fetch;

    const tool = createGetUnreadEmailCountTool(makeClient());
    const result = await tool.execute({}, context);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ count: 3 });
  });

  test("returns a failure result (not a throw) when no account is linked", async () => {
    const unlinkedTokenStore = new CalendarTokenStore(":memory:");
    const client = new GmailClient("client-id", "client-secret", unlinkedTokenStore);
    const tool = createGetUnreadEmailCountTool(client);

    const result = await tool.execute({}, context);
    expect(result.success).toBe(false);
    expect(result.error).toContain("No Google account linked");
  });
});
