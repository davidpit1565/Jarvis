import { describe, test, expect, afterEach } from "bun:test";
import { CalendarTokenStore } from "@/calendar/CalendarTokenStore";
import { GoogleCalendarClient } from "@/calendar/GoogleCalendarClient";
import { createListCalendarEventsTool } from "@/tools/calendar/ListCalendarEventsTool";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function makeClient() {
  const tokenStore = new CalendarTokenStore(":memory:");
  tokenStore.save({ refreshToken: "r1", accessToken: "a1", accessTokenExpiresAt: Date.now() + 3_600_000 });
  return new GoogleCalendarClient("client-id", "client-secret", "https://example.com/callback", tokenStore);
}

describe("LIST_CALENDAR_EVENTS tool", () => {
  test("is READ", () => {
    const tool = createListCalendarEventsTool(makeClient());
    expect(tool.requiredPermission).toBe(PermissionLevel.READ);
  });

  test("returns events on success", async () => {
    global.fetch = (async () =>
      new Response(
        JSON.stringify({ items: [{ id: "e1", summary: "Standup", start: { dateTime: "2026-01-15T09:00:00Z" }, end: { dateTime: "2026-01-15T09:15:00Z" } }] }),
        { status: 200 }
      )) as unknown as typeof fetch;

    const tool = createListCalendarEventsTool(makeClient());
    const result = await tool.execute({}, context);

    expect(result.success).toBe(true);
    expect((result.data as { events: unknown[] }).events).toHaveLength(1);
  });

  test("rejects an invalid maxResults", async () => {
    const tool = createListCalendarEventsTool(makeClient());
    const result = await tool.execute({ maxResults: -1 }, context);
    expect(result.success).toBe(false);
  });

  test("returns a failure result (not a throw) when no account is linked", async () => {
    const unlinkedTokenStore = new CalendarTokenStore(":memory:");
    const client = new GoogleCalendarClient("client-id", "client-secret", "https://example.com/callback", unlinkedTokenStore);
    const tool = createListCalendarEventsTool(client);

    const result = await tool.execute({}, context);
    expect(result.success).toBe(false);
    expect(result.error).toContain("No Google account linked");
  });
});
