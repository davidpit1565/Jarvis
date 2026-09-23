import { describe, test, expect } from "bun:test";
import { ReminderStore } from "@/reminders/ReminderStore";

/**
 * Mirrors index.ts's reminderNotificationInterval tick — specifically the
 * fix making markNotified conditional on Telegram actually confirming the
 * send, instead of firing before delivery is known to have succeeded.
 * Before this fix, getDueUnnotified() would never return a reminder again
 * once notified_at was set, so a single transient Telegram failure
 * permanently and silently dropped the alert with no retry.
 */
async function tick(
  store: ReminderStore,
  nowIso: string,
  sendTelegram: (message: string) => Promise<void>
): Promise<{ sent: string[]; failed: string[] }> {
  const due = store.getDueUnnotified(nowIso);
  const sent: string[] = [];
  const failed: string[] = [];

  for (const reminder of due) {
    try {
      await sendTelegram(`⏰ Reminder: ${reminder.text}`);
      store.markNotified(reminder.id, nowIso);
      sent.push(reminder.id);
    } catch {
      failed.push(reminder.id);
    }
  }

  return { sent, failed };
}

describe("reminder notification delivery gate", () => {
  test("a successful Telegram send marks the reminder notified", async () => {
    const store = new ReminderStore(":memory:");
    const record = store.create({ text: "Call the dentist", dueAt: "2026-01-16T15:00:00.000Z" });

    const result = await tick(store, "2026-01-16T15:00:00.000Z", async () => {});

    expect(result.sent).toEqual([record.id]);
    expect(store.get(record.id)?.notifiedAt).toBe("2026-01-16T15:00:00.000Z");
    store.close();
  });

  test("a failed Telegram send leaves the reminder unnotified, so the next tick retries it", async () => {
    const store = new ReminderStore(":memory:");
    const record = store.create({ text: "Call the dentist", dueAt: "2026-01-16T15:00:00.000Z" });

    const result = await tick(store, "2026-01-16T15:00:00.000Z", async () => {
      throw new Error("Telegram API down");
    });

    expect(result.failed).toEqual([record.id]);
    expect(store.get(record.id)?.notifiedAt).toBeNull();

    // A later tick, once Telegram recovers, actually delivers it.
    const retry = await tick(store, "2026-01-16T15:00:30.000Z", async () => {});
    expect(retry.sent).toEqual([record.id]);
    expect(store.get(record.id)?.notifiedAt).toBe("2026-01-16T15:00:30.000Z");

    store.close();
  });

  test("a reminder already notified is not re-sent on a later tick", async () => {
    const store = new ReminderStore(":memory:");
    const record = store.create({ text: "Call the dentist", dueAt: "2026-01-16T15:00:00.000Z" });

    await tick(store, "2026-01-16T15:00:00.000Z", async () => {});
    const secondTick = await tick(store, "2026-01-16T15:00:30.000Z", async () => {});

    expect(secondTick.sent).toEqual([]);
    expect(secondTick.failed).toEqual([]);
    store.get(record.id);
    store.close();
  });
});
