import { describe, test, expect, afterEach } from "bun:test";
import { CalendarTokenStore } from "@/calendar/CalendarTokenStore";
import { GoogleCalendarClient } from "@/calendar/GoogleCalendarClient";
import { createGetCalendarEventTool } from "@/tools/calendar/GetCalendarEventTool";
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

describe("GET_CALENDAR_EVENT tool", () => {
  test("is READ", () => {
    const tool = createGetCalendarEventTool(makeClient());
    expect(tool.requiredPermission).toBe(PermissionLevel.READ);
  });

  test("returns the event on success", async () => {
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          id: "ev1",
          summary: "Dentist",
          description: "Checkup",
          start: { dateTime: "2026-01-15T09:00:00Z" },
          end: { dateTime: "2026-01-15T09:15:00Z" },
          attendees: [{ email: "alice@example.com" }],
        }),
        { status: 200 }
      )) as unknown as typeof fetch;

    const tool = createGetCalendarEventTool(makeClient());
    const result = await tool.execute({ eventId: "ev1" }, context);

    expect(result.success).toBe(true);
    expect((result.data as { event: { description: string } }).event.description).toBe("Checkup");
  });

  test("rejects a missing/empty eventId", async () => {
    const tool = createGetCalendarEventTool(makeClient());
    expect((await tool.execute({} as never, context)).success).toBe(false);
    expect((await tool.execute({ eventId: "  " }, context)).success).toBe(false);
  });

  test("returns a failure result (not a throw) when no account is linked", async () => {
    const unlinkedTokenStore = new CalendarTokenStore(":memory:");
    const client = new GoogleCalendarClient("client-id", "client-secret", "https://example.com/callback", unlinkedTokenStore);
    const tool = createGetCalendarEventTool(client);

    const result = await tool.execute({ eventId: "ev1" }, context);
    expect(result.success).toBe(false);
    expect(result.error).toContain("No Google account linked");
  });
});
