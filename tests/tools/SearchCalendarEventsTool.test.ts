import { describe, test, expect, afterEach } from "bun:test";
import { CalendarTokenStore } from "@/calendar/CalendarTokenStore";
import { GoogleCalendarClient } from "@/calendar/GoogleCalendarClient";
import { createSearchCalendarEventsTool } from "@/tools/calendar/SearchCalendarEventsTool";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function makeClient() {
  const tokenStore = new CalendarTokenStore(":memory:");
  tokenStore.save("me@example.com", { refreshToken: "r1", accessToken: "a1", accessTokenExpiresAt: Date.now() + 3_600_000 });
  return new GoogleCalendarClient("client-id", "client-secret", "https://example.com/callback", tokenStore);
}

describe("SEARCH_CALENDAR_EVENTS tool", () => {
  test("is READ", () => {
    const tool = createSearchCalendarEventsTool(makeClient());
    expect(tool.requiredPermission).toBe(PermissionLevel.READ);
  });

  test("returns matching events on success", async () => {
    let capturedUrl: string | undefined;
    global.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({
          items: [{ id: "e1", summary: "Dentist", start: { dateTime: "2026-01-15T09:00:00Z" }, end: { dateTime: "2026-01-15T09:15:00Z" } }],
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const tool = createSearchCalendarEventsTool(makeClient());
    const result = await tool.execute({ query: "dentist" }, context);

    expect(result.success).toBe(true);
    expect((result.data as { events: unknown[] }).events).toHaveLength(1);
    expect(new URL(capturedUrl!).searchParams.get("q")).toBe("dentist");
  });

  test("rejects a missing/empty query", async () => {
    const tool = createSearchCalendarEventsTool(makeClient());
    expect((await tool.execute({} as never, context)).success).toBe(false);
    expect((await tool.execute({ query: "  " }, context)).success).toBe(false);
  });

  test("rejects an invalid maxResults", async () => {
    const tool = createSearchCalendarEventsTool(makeClient());
    const result = await tool.execute({ query: "dentist", maxResults: -1 }, context);
    expect(result.success).toBe(false);
  });

  test("returns a failure result (not a throw) when no account is linked", async () => {
    const unlinkedTokenStore = new CalendarTokenStore(":memory:");
    const client = new GoogleCalendarClient("client-id", "client-secret", "https://example.com/callback", unlinkedTokenStore);
    const tool = createSearchCalendarEventsTool(client);

    const result = await tool.execute({ query: "dentist" }, context);
    expect(result.success).toBe(false);
    expect(result.error).toContain("No Google account linked");
  });
});
