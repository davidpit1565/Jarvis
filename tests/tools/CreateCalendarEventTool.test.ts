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
  tokenStore.save("me@example.com", { refreshToken: "r1", accessToken: "a1", accessTokenExpiresAt: Date.now() + 3_600_000 });
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

  test("flags a duplicate when an existing event has the same title and a start time within a few minutes", async () => {
    global.fetch = (async (url: string) => {
      if (url.includes("timeMin") && url.includes("timeMax")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: "existing",
                summary: "Standup",
                start: { dateTime: "2026-01-15T09:02:00Z" },
                end: { dateTime: "2026-01-15T09:17:00Z" },
              },
            ],
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
    const data = result.data as { duplicate: unknown; event: { id: string } };
    expect(data.duplicate).not.toBeNull();
    // Still creates the event — a warning, never a gate.
    expect(data.event.id).toBe("e1");
  });

  test("does not flag a duplicate when the title differs, even at the exact same time", async () => {
    global.fetch = (async (url: string) => {
      if (url.includes("timeMin") && url.includes("timeMax")) {
        return new Response(
          JSON.stringify({
            items: [
              { id: "existing", summary: "Something else", start: { dateTime: "2026-01-15T09:00:00Z" }, end: { dateTime: "2026-01-15T09:15:00Z" } },
            ],
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

    expect((result.data as { duplicate: unknown }).duplicate).toBeNull();
  });

  test("does not flag a duplicate when the title matches but the start time is far off", async () => {
    global.fetch = (async (url: string) => {
      if (url.includes("timeMin") && url.includes("timeMax")) {
        return new Response(
          JSON.stringify({
            items: [
              { id: "existing", summary: "Standup", start: { dateTime: "2026-01-15T15:00:00Z" }, end: { dateTime: "2026-01-15T15:15:00Z" } },
            ],
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

    expect((result.data as { duplicate: unknown }).duplicate).toBeNull();
  });

  test("flags a duplicate even when the existing (short) event ends before the new event starts", async () => {
    global.fetch = (async (url: string) => {
      if (url.includes("timeMin") && url.includes("timeMax")) {
        // Existing "Standup" 09:00-09:02 — ends before the new event's
        // 09:03 start, so a naive listEventsInRange(input.start, input.end)
        // query would never return it at all (Google's timeMin is an
        // exclusive lower bound on the event's END time), even though its
        // start is only 3 minutes off and well within the duplicate window.
        return new Response(
          JSON.stringify({
            items: [
              { id: "existing", summary: "Standup", start: { dateTime: "2026-01-15T09:00:00Z" }, end: { dateTime: "2026-01-15T09:02:00Z" } },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({ id: "e1", summary: "Standup", start: { dateTime: "2026-01-15T09:03:00Z" }, end: { dateTime: "2026-01-15T09:33:00Z" } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const tool = createCreateCalendarEventTool(makeClient());
    const result = await tool.execute({ summary: "Standup", start: "2026-01-15T09:03:00Z", end: "2026-01-15T09:33:00Z" }, context);

    expect(result.success).toBe(true);
    const data = result.data as { duplicate: unknown; conflicts: unknown[] };
    expect(data.duplicate).not.toBeNull();
    // The short existing event doesn't actually overlap the new one's
    // [09:03, 09:33) range, so it must NOT show up as a "conflicts" hit —
    // only as a duplicate warning.
    expect(data.conflicts).toEqual([]);
  });

  test("flags a duplicate even when the existing event starts shortly after a short new event ends", async () => {
    global.fetch = (async (url: string) => {
      if (url.includes("timeMin") && url.includes("timeMax")) {
        // Existing "Standup" 09:04-09:34 — starts after the new event's
        // 09:00-09:01 end, so a query only widened on the START side
        // (timeMax left at input.end = 09:01) would never return it
        // either (Google's timeMax is an exclusive upper bound on the
        // event's START time), even though its start is only 4 minutes
        // off and well within the duplicate window.
        return new Response(
          JSON.stringify({
            items: [
              { id: "existing", summary: "Standup", start: { dateTime: "2026-01-15T09:04:00Z" }, end: { dateTime: "2026-01-15T09:34:00Z" } },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({ id: "e1", summary: "Standup", start: { dateTime: "2026-01-15T09:00:00Z" }, end: { dateTime: "2026-01-15T09:01:00Z" } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const tool = createCreateCalendarEventTool(makeClient());
    const result = await tool.execute({ summary: "Standup", start: "2026-01-15T09:00:00Z", end: "2026-01-15T09:01:00Z" }, context);

    expect(result.success).toBe(true);
    const data = result.data as { duplicate: unknown; conflicts: unknown[] };
    expect(data.duplicate).not.toBeNull();
    expect(data.conflicts).toEqual([]);
  });

  test("does not record anything in the undo store on failure", async () => {
    global.fetch = (async () => new Response("bad request", { status: 400 })) as unknown as typeof fetch;

    const undoStore = new UndoStore();
    const tool = createCreateCalendarEventTool(makeClient(), undoStore);
    await tool.execute({ summary: "Test", start: "2026-01-15T09:00:00Z", end: "2026-01-15T09:15:00Z" }, context);

    expect(undoStore.takeLast()).toBeUndefined();
  });
});
