import { describe, test, expect, afterEach } from "bun:test";
import { CalendarTokenStore } from "@/calendar/CalendarTokenStore";
import { GoogleCalendarClient } from "@/calendar/GoogleCalendarClient";
import { createDeleteCalendarEventTool } from "@/tools/calendar/DeleteCalendarEventTool";
import { UndoStore } from "@/core/undo/UndoStore";
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

  test("records the deleted event's details to the undo store, when given one", async () => {
    global.fetch = (async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return new Response(
        JSON.stringify({
          id: "event-1",
          summary: "Dentist",
          location: "Clinic",
          start: { dateTime: "2026-01-20T10:00:00Z" },
          end: { dateTime: "2026-01-20T10:30:00Z" },
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const undoStore = new UndoStore();
    const tool = createDeleteCalendarEventTool(makeClient(), undoStore);
    await tool.execute({ eventId: "event-1" }, context);

    expect(undoStore.takeLast()).toEqual({
      type: "calendar_event_deleted",
      summary: "Dentist",
      start: "2026-01-20T10:00:00Z",
      end: "2026-01-20T10:30:00Z",
      location: "Clinic",
    });
  });

  test("still deletes successfully even if fetching the event's details first fails", async () => {
    global.fetch = (async (_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const undoStore = new UndoStore();
    const tool = createDeleteCalendarEventTool(makeClient(), undoStore);
    const result = await tool.execute({ eventId: "event-1" }, context);

    expect(result.success).toBe(true);
    expect(undoStore.takeLast()).toBeUndefined();
  });
});
