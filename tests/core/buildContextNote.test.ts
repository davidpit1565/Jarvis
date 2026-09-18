import { describe, test, expect, afterEach } from "bun:test";
import { ReminderStore } from "@/reminders/ReminderStore";
import { buildContextNote } from "@/core/buildContextNote";
import { CalendarTokenStore } from "@/calendar/CalendarTokenStore";
import { GoogleCalendarClient } from "@/calendar/GoogleCalendarClient";

const originalFetch = global.fetch;

describe("buildContextNote", () => {
  test("always includes the current time note", async () => {
    const store = new ReminderStore(":memory:");
    const note = await buildContextNote({ timezone: "UTC" }, store);
    expect(note).toContain("Current date/time");
    store.close();
  });

  test("includes due reminders when present", async () => {
    const store = new ReminderStore(":memory:");
    store.create({ text: "Overdue task", dueAt: "2020-01-01T00:00:00.000Z" });
    const note = await buildContextNote({ timezone: "UTC" }, store);
    expect(note).toContain("Overdue task");
    store.close();
  });

  test("omits the reminders section entirely when there are none due", async () => {
    const store = new ReminderStore(":memory:");
    const note = await buildContextNote({ timezone: "UTC" }, store);
    expect(note).not.toContain("reminder(s) due");
    store.close();
  });

  test("omits calendar context when no calendar client is given", async () => {
    const store = new ReminderStore(":memory:");
    const note = await buildContextNote({ timezone: "UTC" }, store);
    expect(note).not.toContain("calendar");
    store.close();
  });

  test("includes calendar events when a calendar client is given", async () => {
    global.fetch = (async () =>
      new Response(
        JSON.stringify({ items: [{ id: "e1", summary: "Team sync", start: { dateTime: "2026-01-15T09:00:00Z" }, end: { dateTime: "2026-01-15T09:30:00Z" } }] }),
        { status: 200 }
      )) as unknown as typeof fetch;

    const store = new ReminderStore(":memory:");
    const tokenStore = new CalendarTokenStore(":memory:");
    tokenStore.save({ refreshToken: "r1", accessToken: "a1", accessTokenExpiresAt: Date.now() + 3_600_000 });
    const calendarClient = new GoogleCalendarClient("id", "secret", "https://example.com/callback", tokenStore);

    const note = await buildContextNote({ timezone: "UTC" }, store, calendarClient);
    expect(note).toContain("Team sync");

    global.fetch = originalFetch;
    store.close();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });
});
