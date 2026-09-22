import { describe, test, expect, afterEach } from "bun:test";
import { CalendarTokenStore } from "@/calendar/CalendarTokenStore";
import { GoogleCalendarClient } from "@/calendar/GoogleCalendarClient";
import { todayCalendarNote } from "@/calendar/todayCalendarNote";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function makeLinkedClient() {
  const tokenStore = new CalendarTokenStore(":memory:");
  tokenStore.save("me@example.com", { refreshToken: "r1", accessToken: "a1", accessTokenExpiresAt: Date.now() + 3_600_000 });
  return new GoogleCalendarClient("id", "secret", "https://example.com/callback", tokenStore);
}

describe("todayCalendarNote", () => {
  test("returns undefined when there are no upcoming events", async () => {
    global.fetch = (async () => new Response(JSON.stringify({ items: [] }), { status: 200 })) as unknown as typeof fetch;
    expect(await todayCalendarNote(makeLinkedClient())).toBeUndefined();
  });

  test("formats events with their time and location", async () => {
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          items: [{ id: "e1", summary: "Dentist", start: { dateTime: "2026-01-15T09:00:00Z" }, end: { dateTime: "2026-01-15T09:30:00Z" }, location: "Clinic" }],
        }),
        { status: 200 }
      )) as unknown as typeof fetch;

    const note = await todayCalendarNote(makeLinkedClient());
    expect(note).toContain("Dentist");
    expect(note).toContain("Clinic");
  });

  test("returns undefined (not a throw) when the calendar client fails, e.g. not linked yet", async () => {
    const unlinkedTokenStore = new CalendarTokenStore(":memory:");
    const client = new GoogleCalendarClient("id", "secret", "https://example.com/callback", unlinkedTokenStore);
    expect(await todayCalendarNote(client)).toBeUndefined();
  });
});
