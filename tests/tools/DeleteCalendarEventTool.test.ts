import { describe, test, expect, afterEach } from "bun:test";
import { CalendarTokenStore } from "@/calendar/CalendarTokenStore";
import { GoogleCalendarClient } from "@/calendar/GoogleCalendarClient";
import { createDeleteCalendarEventTool } from "@/tools/calendar/DeleteCalendarEventTool";
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

describe("DELETE_CALENDAR_EVENT tool", () => {
  test("is SAFE_ACTION", () => {
    const tool = createDeleteCalendarEventTool(makeClient());
    expect(tool.requiredPermission).toBe(PermissionLevel.SAFE_ACTION);
  });

  test("deletes an event on success", async () => {
    global.fetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;

    const tool = createDeleteCalendarEventTool(makeClient());
    const result = await tool.execute({ eventId: "event-1" }, context);

    expect(result.success).toBe(true);
    expect((result.data as { eventId: string }).eventId).toBe("event-1");
  });

  test("rejects an empty eventId", async () => {
    const tool = createDeleteCalendarEventTool(makeClient());
    const result = await tool.execute({ eventId: "" }, context);
    expect(result.success).toBe(false);
  });

  test("returns a failure result (not a throw) on an API error", async () => {
    global.fetch = (async () => new Response("forbidden", { status: 403 })) as unknown as typeof fetch;

    const tool = createDeleteCalendarEventTool(makeClient());
    const result = await tool.execute({ eventId: "event-1" }, context);
    expect(result.success).toBe(false);
  });
});
