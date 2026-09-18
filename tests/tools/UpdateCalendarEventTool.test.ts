import { describe, test, expect, afterEach } from "bun:test";
import { CalendarTokenStore } from "@/calendar/CalendarTokenStore";
import { GoogleCalendarClient } from "@/calendar/GoogleCalendarClient";
import { createUpdateCalendarEventTool } from "@/tools/calendar/UpdateCalendarEventTool";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function makeClient() {
  const tokenStore = new CalendarTokenStore(":memory:");
  tokenStore.save({ refreshToken: "r1", accessToken: "a1", accessTokenExpiresAt: Date.now() + 3_600_000 });
  return new GoogleCalendarClient("id", "secret", "https://example.com/callback", tokenStore);
}

describe("UPDATE_CALENDAR_EVENT tool", () => {
  test("is SAFE_ACTION", () => {
    const tool = createUpdateCalendarEventTool(makeClient());
    expect(tool.requiredPermission).toBe(PermissionLevel.SAFE_ACTION);
  });

  test("updates the event on success", async () => {
    global.fetch = (async () =>
      new Response(
        JSON.stringify({ id: "ev1", summary: "Moved", start: { dateTime: "2026-01-20T11:00:00Z" }, end: { dateTime: "2026-01-20T11:30:00Z" } }),
        { status: 200 }
      )) as unknown as typeof fetch;

    const tool = createUpdateCalendarEventTool(makeClient());
    const result = await tool.execute({ eventId: "ev1", start: "2026-01-20T11:00:00Z" }, context);

    expect(result.success).toBe(true);
    expect((result.data as { event: { summary: string } }).event.summary).toBe("Moved");
  });

  test("rejects a missing eventId", async () => {
    const tool = createUpdateCalendarEventTool(makeClient());
    const result = await tool.execute({ eventId: "" }, context);
    expect(result.success).toBe(false);
  });

  test("rejects an invalid start", async () => {
    const tool = createUpdateCalendarEventTool(makeClient());
    const result = await tool.execute({ eventId: "ev1", start: "not-a-date" }, context);
    expect(result.success).toBe(false);
  });

  test("rejects an empty summary", async () => {
    const tool = createUpdateCalendarEventTool(makeClient());
    const result = await tool.execute({ eventId: "ev1", summary: "" }, context);
    expect(result.success).toBe(false);
  });

  test("returns a failure result (not a throw) on an API error", async () => {
    global.fetch = (async () => new Response("bad request", { status: 400 })) as unknown as typeof fetch;

    const tool = createUpdateCalendarEventTool(makeClient());
    const result = await tool.execute({ eventId: "ev1", summary: "New" }, context);
    expect(result.success).toBe(false);
  });
});
