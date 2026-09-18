import { describe, test, expect, afterEach } from "bun:test";
import { CalendarTokenStore } from "@/calendar/CalendarTokenStore";
import { GoogleCalendarClient } from "@/calendar/GoogleCalendarClient";
import { createUpdateCalendarEventTool } from "@/tools/calendar/UpdateCalendarEventTool";
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

  test("records the event's previous values to the undo store, when given one", async () => {
    global.fetch = (async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return new Response(
          JSON.stringify({ id: "ev1", summary: "Dentist", start: { dateTime: "2026-01-20T11:00:00Z" }, end: { dateTime: "2026-01-20T11:30:00Z" } }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({ id: "ev1", summary: "Dentist", location: "Clinic", start: { dateTime: "2026-01-20T10:00:00Z" }, end: { dateTime: "2026-01-20T11:45:00Z" } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const undoStore = new UndoStore();
    const tool = createUpdateCalendarEventTool(makeClient(), undoStore);
    await tool.execute({ eventId: "ev1", start: "2026-01-20T11:00:00Z" }, context);

    expect(undoStore.takeLast()).toEqual({
      type: "calendar_event_updated",
      eventId: "ev1",
      previous: { summary: "Dentist", start: "2026-01-20T10:00:00Z", end: "2026-01-20T11:45:00Z", location: "Clinic" },
    });
  });

  test("rejects when the new start and end are both provided with end before start", async () => {
    const tool = createUpdateCalendarEventTool(makeClient());
    const result = await tool.execute(
      { eventId: "ev1", start: "2026-01-20T12:00:00Z", end: "2026-01-20T11:00:00Z" },
      context
    );
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toMatch(/end must be after start/);
  });

  test("rejects a new start that would push past the event's existing (unchanged) end", async () => {
    global.fetch = (async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        throw new Error("should not reach the API — validation should reject first");
      }
      return new Response(
        JSON.stringify({ id: "ev1", summary: "Dentist", start: { dateTime: "2026-01-20T10:00:00Z" }, end: { dateTime: "2026-01-20T10:30:00Z" } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const tool = createUpdateCalendarEventTool(makeClient());
    const result = await tool.execute({ eventId: "ev1", start: "2026-01-20T11:00:00Z" }, context);

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toMatch(/end must be after start/);
  });

  test("rejects a new end that would land before the event's existing (unchanged) start", async () => {
    global.fetch = (async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        throw new Error("should not reach the API — validation should reject first");
      }
      return new Response(
        JSON.stringify({ id: "ev1", summary: "Dentist", start: { dateTime: "2026-01-20T10:00:00Z" }, end: { dateTime: "2026-01-20T10:30:00Z" } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const tool = createUpdateCalendarEventTool(makeClient());
    const result = await tool.execute({ eventId: "ev1", end: "2026-01-20T09:00:00Z" }, context);

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toMatch(/end must be after start/);
  });

  test("still updates successfully even if fetching the event's previous values fails", async () => {
    global.fetch = (async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return new Response(
          JSON.stringify({ id: "ev1", summary: "Dentist", start: { dateTime: "2026-01-20T11:00:00Z" }, end: { dateTime: "2026-01-20T11:30:00Z" } }),
          { status: 200 }
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const undoStore = new UndoStore();
    const tool = createUpdateCalendarEventTool(makeClient(), undoStore);
    const result = await tool.execute({ eventId: "ev1", start: "2026-01-20T11:00:00Z" }, context);

    expect(result.success).toBe(true);
    expect(undoStore.takeLast()).toBeUndefined();
  });
});
