import { describe, test, expect, afterEach } from "bun:test";
import { ReminderStore } from "@/reminders/ReminderStore";
import { buildContextNote } from "@/core/buildContextNote";
import { CalendarTokenStore } from "@/calendar/CalendarTokenStore";
import { GoogleCalendarClient } from "@/calendar/GoogleCalendarClient";
import { CommitmentStore } from "@/commitments/CommitmentStore";

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
    tokenStore.save("me@example.com", { refreshToken: "r1", accessToken: "a1", accessTokenExpiresAt: Date.now() + 3_600_000 });
    const calendarClient = new GoogleCalendarClient("id", "secret", "https://example.com/callback", tokenStore);

    const note = await buildContextNote({ timezone: "UTC" }, store, calendarClient);
    expect(note).toContain("Team sync");

    global.fetch = originalFetch;
    store.close();
  });

  test("omits stale-commitment context when no commitmentStore is given", async () => {
    const store = new ReminderStore(":memory:");
    const note = await buildContextNote({ timezone: "UTC" }, store);
    expect(note).not.toContain("commitment(s)");
    store.close();
  });

  test("omits stale-commitment context when there are none stale", async () => {
    const store = new ReminderStore(":memory:");
    const commitmentStore = new CommitmentStore(":memory:");
    commitmentStore.create({ text: "Still open, not stale yet" });

    const note = await buildContextNote({ timezone: "UTC" }, store, undefined, commitmentStore);
    expect(note).not.toContain("commitment(s)");
    store.close();
    commitmentStore.close();
  });

  test("includes stale commitments when present", async () => {
    const store = new ReminderStore(":memory:");
    const commitmentStore = new CommitmentStore(":memory:");
    const record = commitmentStore.create({ text: "Follow up about the invoice", dueContext: "tomorrow" });
    commitmentStore.markStale(record.id);

    const note = await buildContextNote({ timezone: "UTC" }, store, undefined, commitmentStore);
    expect(note).toContain("Follow up about the invoice");
    expect(note).toContain("stale");
    store.close();
    commitmentStore.close();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });
});
