import { describe, test, expect } from "bun:test";
import { ReminderStore } from "@/reminders/ReminderStore";

/**
 * Mirrors index.ts's reminderNotificationInterval tick — specifically the
 * fix making markNotified conditional on Telegram actually confirming the
 * send, instead of firing before delivery is known to have succeeded.
 * Before this fix, getDueUnnotified() would never return a reminder again
 * once notified_at was set, so a single transient Telegram failure
 * permanently and silently dropped the alert with no retry.
 *
 * Also mirrors the later in-flight-guard fix: setInterval fires every 30s
 * regardless of whether a previous tick's sendMessage calls have resolved,
 * so a slow send still in flight when the next tick runs would otherwise
 * find the same reminder (notified_at still null) and re-send it before
 * the first send's markNotified has a chance to run. `inFlightIds` mirrors
 * the real scheduler's guard, filtering getDueUnnotified()'s result before
 * each tick starts new sends.
 */
async function tick(
  store: ReminderStore,
  nowIso: string,
  inFlightIds: Set<string>,
  sendTelegram: (message: string) => Promise<void>
): Promise<{ sent: string[]; failed: string[] }> {
  const due = store.getDueUnnotified(nowIso).filter((r) => !inFlightIds.has(r.id));
  const sent: string[] = [];
  const failed: string[] = [];

  for (const reminder of due) {
    inFlightIds.add(reminder.id);
    try {
      await sendTelegram(`⏰ Reminder: ${reminder.text}`);
      store.markNotified(reminder.id, nowIso);
      sent.push(reminder.id);
    } catch {
      failed.push(reminder.id);
    } finally {
      inFlightIds.delete(reminder.id);
    }
  }

  return { sent, failed };
}

describe("reminder notification delivery gate", () => {
  test("a successful Telegram send marks the reminder notified", async () => {
    const store = new ReminderStore(":memory:");
    const record = store.create({ text: "Call the dentist", dueAt: "2026-01-16T15:00:00.000Z" });

    const result = await tick(store, "2026-01-16T15:00:00.000Z", new Set(), async () => {});

    expect(result.sent).toEqual([record.id]);
    expect(store.get(record.id)?.notifiedAt).toBe("2026-01-16T15:00:00.000Z");
    store.close();
  });

  test("a failed Telegram send leaves the reminder unnotified, so the next tick retries it", async () => {
    const store = new ReminderStore(":memory:");
    const record = store.create({ text: "Call the dentist", dueAt: "2026-01-16T15:00:00.000Z" });

    const result = await tick(store, "2026-01-16T15:00:00.000Z", new Set(), async () => {
      throw new Error("Telegram API down");
    });

    expect(result.failed).toEqual([record.id]);
    expect(store.get(record.id)?.notifiedAt).toBeNull();

    // A later tick, once Telegram recovers, actually delivers it.
    const retry = await tick(store, "2026-01-16T15:00:30.000Z", new Set(), async () => {});
    expect(retry.sent).toEqual([record.id]);
    expect(store.get(record.id)?.notifiedAt).toBe("2026-01-16T15:00:30.000Z");

    store.close();
  });

  test("a reminder already notified is not re-sent on a later tick", async () => {
    const store = new ReminderStore(":memory:");
    const record = store.create({ text: "Call the dentist", dueAt: "2026-01-16T15:00:00.000Z" });

    await tick(store, "2026-01-16T15:00:00.000Z", new Set(), async () => {});
    const secondTick = await tick(store, "2026-01-16T15:00:30.000Z", new Set(), async () => {});

    expect(secondTick.sent).toEqual([]);
    expect(secondTick.failed).toEqual([]);
    store.get(record.id);
    store.close();
  });

  test("a reminder whose send is still in flight is not re-sent by a concurrent/overlapping tick", async () => {
    const store = new ReminderStore(":memory:");
    const record = store.create({ text: "Call the dentist", dueAt: "2026-01-16T15:00:00.000Z" });
    const inFlightIds = new Set<string>();

    let resolveFirstSend!: () => void;
    const firstSend = new Promise<void>((resolve) => {
      resolveFirstSend = resolve;
    });

    // Tick 1 starts a slow send and isn't awaited here yet — mirrors a
    // send still pending when the next 30s tick fires.
    const tick1 = tick(store, "2026-01-16T15:00:00.000Z", inFlightIds, () => firstSend);
    // Tick 2 fires while tick 1's send is still in flight — the same
    // reminder is still due-and-unnotified, but it's now in inFlightIds.
    const tick2 = tick(store, "2026-01-16T15:00:00.000Z", inFlightIds, async () => {
      throw new Error("should never be called — the reminder is in flight");
    });

    resolveFirstSend();
    const [result1, result2] = await Promise.all([tick1, tick2]);

    expect(result1.sent).toEqual([record.id]);
    expect(result2.sent).toEqual([]);
    expect(result2.failed).toEqual([]);
    expect(store.get(record.id)?.notifiedAt).toBe("2026-01-16T15:00:00.000Z");
    store.close();
  });
});
