import { describe, test, expect } from "bun:test";
import { ReminderStore } from "@/reminders/ReminderStore";
import { isQuietHours, isSuppressibleByQuietHours, type QuietHoursWindow } from "@/notifications/quietHours";
import { formatTimeOfDay } from "@/wakeup/getDueWakeUpCalls";

/**
 * Mirrors the exact gating logic index.ts's reminderNotificationInterval
 * tick applies (see the tick's own doc comment): during quiet hours, a
 * due-but-unnotified reminder is left alone rather than marked notified,
 * so the next tick that lands outside the window picks it up and sends
 * it — "queued to fire at the window's end" without a separate queue.
 */
function tick(store: ReminderStore, now: Date, timeZone: string, window: QuietHoursWindow | undefined): string[] {
  if (isSuppressibleByQuietHours("reminder") && isQuietHours(formatTimeOfDay(now, timeZone), window)) return [];
  const nowIso = now.toISOString();
  const due = store.getDueUnnotified(nowIso);
  const sent: string[] = [];
  for (const reminder of due) {
    store.markNotified(reminder.id, nowIso);
    sent.push(reminder.id);
  }
  return sent;
}

describe("reminder notification quiet-hours suppression", () => {
  const window: QuietHoursWindow = { start: "22:00", end: "07:00" };

  test("a reminder due at 3am (inside quiet hours) is not sent and stays unnotified", () => {
    const store = new ReminderStore(":memory:");
    const record = store.create({ text: "Take out the trash", dueAt: "2026-01-16T03:00:00.000Z" });

    const sent = tick(store, new Date("2026-01-16T03:00:00.000Z"), "UTC", window);

    expect(sent).toEqual([]);
    expect(store.get(record.id)?.notifiedAt).toBeNull();
    store.close();
  });

  test("the same reminder is sent once quiet hours end (07:00), and only then", () => {
    const store = new ReminderStore(":memory:");
    const record = store.create({ text: "Take out the trash", dueAt: "2026-01-16T03:00:00.000Z" });

    // 06:59 — still quiet, still queued.
    const beforeEnd = tick(store, new Date("2026-01-16T06:59:00.000Z"), "UTC", window);
    expect(beforeEnd).toEqual([]);
    expect(store.get(record.id)?.notifiedAt).toBeNull();

    // 07:00 — quiet hours just ended, the queued reminder fires now.
    const atEnd = tick(store, new Date("2026-01-16T07:00:00.000Z"), "UTC", window);
    expect(atEnd).toEqual([record.id]);
    expect(store.get(record.id)?.notifiedAt).toBe("2026-01-16T07:00:00.000Z");

    // A later tick doesn't resend it.
    const afterEnd = tick(store, new Date("2026-01-16T07:00:30.000Z"), "UTC", window);
    expect(afterEnd).toEqual([]);
    store.close();
  });

  test("a reminder due at 3pm (outside quiet hours) is sent immediately, unaffected", () => {
    const store = new ReminderStore(":memory:");
    const record = store.create({ text: "Call the dentist", dueAt: "2026-01-16T15:00:00.000Z" });

    const sent = tick(store, new Date("2026-01-16T15:00:00.000Z"), "UTC", window);

    expect(sent).toEqual([record.id]);
    expect(store.get(record.id)?.notifiedAt).toBe("2026-01-16T15:00:00.000Z");
    store.close();
  });

  test("with no quiet hours configured, a 3am reminder is sent immediately (opt-out: feature disabled)", () => {
    const store = new ReminderStore(":memory:");
    const record = store.create({ text: "Take out the trash", dueAt: "2026-01-16T03:00:00.000Z" });

    const sent = tick(store, new Date("2026-01-16T03:00:00.000Z"), "UTC", undefined);

    expect(sent).toEqual([record.id]);
    store.close();
  });
});
