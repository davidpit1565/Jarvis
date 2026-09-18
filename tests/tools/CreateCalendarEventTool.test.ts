import { describe, test, expect, afterEach } from "bun:test";
import { CalendarTokenStore } from "@/calendar/CalendarTokenStore";
import { GoogleCalendarClient } from "@/calendar/GoogleCalendarClient";
import { createCreateCalendarEventTool } from "@/tools/calendar/CreateCalendarEventTool";
import { PermissionLevel } from "@/types/permissions";
import { UndoStore } from "@/core/undo/UndoStore";

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

describe("CREATE_CALENDAR_EVENT tool", () => {
  test("is SAFE_ACTION", () => {
    const tool = createCreateCalendarEventTool(makeClient());
    expect(tool.requiredPermission).toBe(PermissionLevel.SAFE_ACTION);
  });

  test("creates an event on success", async () => {
    global.fetch = (async () =>
      new Response(
        JSON.stringify({ id: "e1", summary: "Standup", start: { dateTime: "2026-01-15T09:00:00Z" }, end: { dateTime: "2026-01-15T09:15:00Z" } }),
        { status: 200 }
      )) as unknown as typeof fetch;

    const tool = createCreateCalendarEventTool(makeClient());
    const result = await tool.execute({ summary: "Standup", start: "2026-01-15T09:00:00Z", end: "2026-01-15T09:15:00Z" }, context);

    expect(result.success).toBe(true);
  });

  test("rejects a missing summary", async () => {
    const tool = createCreateCalendarEventTool(makeClient());
    const result = await tool.execute({ summary: "", start: "2026-01-15T09:00:00Z", end: "2026-01-15T09:15:00Z" }, context);
    expect(result.success).toBe(false);
  });

  test("rejects an invalid start timestamp", async () => {
    const tool = createCreateCalendarEventTool(makeClient());
    const result = await tool.execute({ summary: "Test", start: "not-a-date", end: "2026-01-15T09:15:00Z" }, context);
    expect(result.success).toBe(false);
  });

  test("rejects end before start", async () => {
    const tool = createCreateCalendarEventTool(makeClient());
    const result = await tool.execute(
      { summary: "Test", start: "2026-01-15T09:15:00Z", end: "2026-01-15T09:00:00Z" },
      context
    );
    expect(result.success).toBe(false);
  });

  test("returns a failure result (not a throw) on an API error", async () => {
    global.fetch = (async () => new Response("bad request", { status: 400 })) as unknown as typeof fetch;

    const tool = createCreateCalendarEventTool(makeClient());
    const result = await tool.execute({ summary: "Test", start: "2026-01-15T09:00:00Z", end: "2026-01-15T09:15:00Z" }, context);
    expect(result.success).toBe(false);
  });

  test("records the created event in the undo store when one is provided", async () => {
    global.fetch = (async () =>
      new Response(
        JSON.stringify({ id: "e1", summary: "Standup", start: { dateTime: "2026-01-15T09:00:00Z" }, end: { dateTime: "2026-01-15T09:15:00Z" } }),
        { status: 200 }
      )) as unknown as typeof fetch;

    const undoStore = new UndoStore();
    const tool = createCreateCalendarEventTool(makeClient(), undoStore);
    await tool.execute({ summary: "Standup", start: "2026-01-15T09:00:00Z", end: "2026-01-15T09:15:00Z" }, context);

    expect(undoStore.takeLast()).toEqual({ type: "calendar_event_created", eventId: "e1", summary: "Standup" });
  });

  test("includes conflicts when an overlapping event already exists", async () => {
    global.fetch = (async (url: string) => {
      if (url.includes("timeMin") && url.includes("timeMax")) {
        return new Response(
          JSON.stringify({
            items: [{ id: "existing", summary: "Existing meeting", start: { dateTime: "2026-01-15T09:00:00Z" }, end: { dateTime: "2026-01-15T09:30:00Z" } }],
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({ id: "e1", summary: "Standup", start: { dateTime: "2026-01-15T09:00:00Z" }, end: { dateTime: "2026-01-15T09:15:00Z" } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const tool = createCreateCalendarEventTool(makeClient());
    const result = await tool.execute({ summary: "Standup", start: "2026-01-15T09:00:00Z", end: "2026-01-15T09:15:00Z" }, context);

    expect(result.success).toBe(true);
    const conflicts = (result.data as { conflicts: unknown[] }).conflicts;
    expect(conflicts).toHaveLength(1);
  });

  test("still creates the event when the conflict check itself fails", async () => {
    global.fetch = (async (url: string) => {
      if (url.includes("timeMin") && url.includes("timeMax")) {
        return new Response("boom", { status: 500 });
      }
      return new Response(
        JSON.stringify({ id: "e1", summary: "Standup", start: { dateTime: "2026-01-15T09:00:00Z" }, end: { dateTime: "2026-01-15T09:15:00Z" } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const tool = createCreateCalendarEventTool(makeClient());
    const result = await tool.execute({ summary: "Standup", start: "2026-01-15T09:00:00Z", end: "2026-01-15T09:15:00Z" }, context);

    expect(result.success).toBe(true);
    expect((result.data as { conflicts: unknown[] }).conflicts).toEqual([]);
  });

  test("does not record anything in the undo store on failure", async () => {
    global.fetch = (async () => new Response("bad request", { status: 400 })) as unknown as typeof fetch;

    const undoStore = new UndoStore();
    const tool = createCreateCalendarEventTool(makeClient(), undoStore);
    await tool.execute({ summary: "Test", start: "2026-01-15T09:00:00Z", end: "2026-01-15T09:15:00Z" }, context);

    expect(undoStore.takeLast()).toBeUndefined();
  });
});
