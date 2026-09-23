import { describe, test, expect } from "bun:test";
import { ReminderStore } from "@/reminders/ReminderStore";

describe("ReminderStore", () => {
  test("creates a reminder and retrieves it by id", () => {
    const store = new ReminderStore(":memory:");
    const record = store.create({ text: "Pick up dry cleaning" });

    const fetched = store.get(record.id);
    expect(fetched?.text).toBe("Pick up dry cleaning");
    expect(fetched?.dueAt).toBeNull();
    expect(fetched?.completed).toBe(false);
    store.close();
  });

  test("creates an already-completed reminder when restoring prior state, without spawning a recurrence occurrence", () => {
    const store = new ReminderStore(":memory:");
    const record = store.create({
      text: "Take medication",
      dueAt: "2026-01-15T08:00:00.000Z",
      recurrence: "daily",
      completed: true,
    });

    const fetched = store.get(record.id);
    expect(fetched?.completed).toBe(true);
    expect(store.list(true)).toHaveLength(1);
    store.close();
  });

  test("creates a dated reminder", () => {
    const store = new ReminderStore(":memory:");
    const dueAt = "2026-09-19T18:00:00.000Z";
    const record = store.create({ text: "Call the dentist", dueAt });

    expect(record.dueAt).toBe(dueAt);
    store.close();
  });

  test("returns null for an unknown id", () => {
    const store = new ReminderStore(":memory:");
    expect(store.get("missing-id")).toBeNull();
    store.close();
  });

  test("list excludes completed reminders by default", () => {
    const store = new ReminderStore(":memory:");
    const a = store.create({ text: "Task A" });
    const b = store.create({ text: "Task B" });
    store.complete(a.id);

    const pending = store.list();
    expect(pending.map((r) => r.id)).toEqual([b.id]);
    store.close();
  });

  test("list with includeCompleted=true returns everything", () => {
    const store = new ReminderStore(":memory:");
    const a = store.create({ text: "Task A" });
    const b = store.create({ text: "Task B" });
    store.complete(a.id);

    const all = store.list(true);
    expect(all).toHaveLength(2);
    expect(all.find((r) => r.id === a.id)?.completed).toBe(true);
    expect(all.find((r) => r.id === b.id)?.completed).toBe(false);
    store.close();
  });

  test("dated reminders sort soonest-due first, undated ones last", () => {
    const store = new ReminderStore(":memory:");
    const undated = store.create({ text: "Someday task" });
    const later = store.create({ text: "Later task", dueAt: "2026-12-01T00:00:00.000Z" });
    const soon = store.create({ text: "Soon task", dueAt: "2026-09-19T00:00:00.000Z" });

    const list = store.list();
    expect(list.map((r) => r.id)).toEqual([soon.id, later.id, undated.id]);
    store.close();
  });

  test("complete returns true and marks the reminder done", () => {
    const store = new ReminderStore(":memory:");
    const record = store.create({ text: "Task" });

    expect(store.complete(record.id)).toBe(true);
    expect(store.get(record.id)?.completed).toBe(true);
    store.close();
  });

  test("complete returns false for unknown id", () => {
    const store = new ReminderStore(":memory:");
    expect(store.complete("missing-id")).toBe(false);
    store.close();
  });

  test("delete removes the reminder entirely", () => {
    const store = new ReminderStore(":memory:");
    const record = store.create({ text: "Task" });

    expect(store.delete(record.id)).toBe(true);
    expect(store.get(record.id)).toBeNull();
    store.close();
  });

  test("creates a recurring reminder with the given recurrence", () => {
    const store = new ReminderStore(":memory:");
    const record = store.create({ text: "Take medication", dueAt: "2026-01-15T08:00:00.000Z", recurrence: "daily" });

    expect(record.recurrence).toBe("daily");
    store.close();
  });

  test("completing a daily recurring reminder creates the next occurrence, one day later", () => {
    const store = new ReminderStore(":memory:");
    const record = store.create({ text: "Take medication", dueAt: "2026-01-15T08:00:00.000Z", recurrence: "daily" });

    expect(store.complete(record.id)).toBe(true);

    const pending = store.list();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.text).toBe("Take medication");
    expect(pending[0]?.dueAt).toBe("2026-01-16T08:00:00.000Z");
    expect(pending[0]?.recurrence).toBe("daily");
    expect(pending[0]?.completed).toBe(false);
    store.close();
  });

  test("completing an already-completed reminder is a no-op — it doesn't duplicate the next recurring occurrence", () => {
    const store = new ReminderStore(":memory:");
    const record = store.create({ text: "Take medication", dueAt: "2026-01-15T08:00:00.000Z", recurrence: "daily" });

    expect(store.complete(record.id)).toBe(true);
    expect(store.complete(record.id)).toBe(false);
    expect(store.complete(record.id)).toBe(false);

    expect(store.list()).toHaveLength(1);
    store.close();
  });

  test("completing a weekly recurring reminder creates the next occurrence, seven days later", () => {
    const store = new ReminderStore(":memory:");
    const record = store.create({ text: "Water the plants", dueAt: "2026-01-15T08:00:00.000Z", recurrence: "weekly" });

    store.complete(record.id);

    const [next] = store.list();
    expect(next?.dueAt).toBe("2026-01-22T08:00:00.000Z");
    store.close();
  });

  test("advances a daily reminder by a calendar day, not a fixed 24h, across a spring-forward DST transition (America/New_York)", () => {
    // 2026-03-08 is the US spring-forward date: clocks jump from 2:00am to
    // 3:00am EST->EDT. A reminder due 9:00am local on Saturday the 7th
    // (still EST, UTC-5, so 14:00 UTC) should recur to 9:00am local on
    // Sunday the 8th (now EDT, UTC-4, so 13:00 UTC) — a naive
    // +24h-in-UTC would instead land it at 14:00 UTC, which is 10:00am
    // local, one hour late.
    const store = new ReminderStore(":memory:", "America/New_York");
    const record = store.create({ text: "Take medication", dueAt: "2026-03-07T14:00:00.000Z", recurrence: "daily" });

    store.complete(record.id);

    const [next] = store.list();
    expect(next?.dueAt).toBe("2026-03-08T13:00:00.000Z");
    store.close();
  });

  test("advances a weekly reminder by calendar days, not a fixed 168h, across a fall-back DST transition (America/New_York)", () => {
    // 2026-11-01 is the US fall-back date: clocks fall from 2:00am back to
    // 1:00am EDT->EST. A reminder due 9:00am local on 2026-10-25 (EDT,
    // UTC-4, so 13:00 UTC) should recur to 9:00am local on 2026-11-01 (now
    // EST, UTC-5, so 14:00 UTC) — a naive +168h-in-UTC would instead land
    // it at 13:00 UTC, which is 8:00am local, one hour early.
    const store = new ReminderStore(":memory:", "America/New_York");
    const record = store.create({ text: "Water the plants", dueAt: "2026-10-25T13:00:00.000Z", recurrence: "weekly" });

    store.complete(record.id);

    const [next] = store.list();
    expect(next?.dueAt).toBe("2026-11-01T14:00:00.000Z");
    store.close();
  });

  test("advancing by a calendar day for a UTC-configured store still adds exactly 24 hours (no DST in UTC)", () => {
    const store = new ReminderStore(":memory:");
    const record = store.create({ text: "Take medication", dueAt: "2026-03-08T14:00:00.000Z", recurrence: "daily" });

    store.complete(record.id);

    const [next] = store.list();
    expect(next?.dueAt).toBe("2026-03-09T14:00:00.000Z");
    store.close();
  });

  test("the original occurrence stays marked completed after recurring", () => {
    const store = new ReminderStore(":memory:");
    const record = store.create({ text: "Take medication", dueAt: "2026-01-15T08:00:00.000Z", recurrence: "daily" });

    store.complete(record.id);

    expect(store.get(record.id)?.completed).toBe(true);
    store.close();
  });

  test("completing a recurring reminder with no dueAt does not recur", () => {
    const store = new ReminderStore(":memory:");
    const record = store.create({ text: "Undated recurring", recurrence: "daily" });

    store.complete(record.id);

    expect(store.list()).toHaveLength(0);
    store.close();
  });

  test("completing a one-off reminder (no recurrence) does not create anything new", () => {
    const store = new ReminderStore(":memory:");
    const record = store.create({ text: "One-off task" });

    store.complete(record.id);

    expect(store.list()).toHaveLength(0);
    store.close();
  });

  test("delete returns false for unknown id", () => {
    const store = new ReminderStore(":memory:");
    expect(store.delete("missing-id")).toBe(false);
    store.close();
  });

  test("update changes text and dueAt", () => {
    const store = new ReminderStore(":memory:");
    const record = store.create({ text: "Call mom", dueAt: "2026-09-19T18:00:00.000Z" });

    const updated = store.update(record.id, { text: "Call dad", dueAt: "2026-09-19T19:00:00.000Z" });

    expect(updated?.text).toBe("Call dad");
    expect(updated?.dueAt).toBe("2026-09-19T19:00:00.000Z");
    expect(store.get(record.id)?.text).toBe("Call dad");
    store.close();
  });

  test("update with only one field leaves the other unchanged", () => {
    const store = new ReminderStore(":memory:");
    const record = store.create({ text: "Call mom", dueAt: "2026-09-19T18:00:00.000Z" });

    const updated = store.update(record.id, { text: "Call dad" });

    expect(updated?.text).toBe("Call dad");
    expect(updated?.dueAt).toBe("2026-09-19T18:00:00.000Z");
    store.close();
  });

  test("update with dueAt: null clears the due date", () => {
    const store = new ReminderStore(":memory:");
    const record = store.create({ text: "Task", dueAt: "2026-09-19T18:00:00.000Z" });

    const updated = store.update(record.id, { dueAt: null });

    expect(updated?.dueAt).toBeNull();
    store.close();
  });

  test("update returns null for unknown id", () => {
    const store = new ReminderStore(":memory:");
    expect(store.update("missing-id", { text: "x" })).toBeNull();
    store.close();
  });

  test("update can set recurrence on an existing reminder", () => {
    const store = new ReminderStore(":memory:");
    const record = store.create({ text: "Task", dueAt: "2026-09-19T18:00:00.000Z" });

    const updated = store.update(record.id, { recurrence: "weekly" });

    expect(updated?.recurrence).toBe("weekly");
    store.close();
  });

  test("update with recurrence: null stops it from recurring", () => {
    const store = new ReminderStore(":memory:");
    const record = store.create({ text: "Task", dueAt: "2026-09-19T18:00:00.000Z", recurrence: "daily" });

    const updated = store.update(record.id, { recurrence: null });

    expect(updated?.recurrence).toBeNull();
    store.close();
  });

  test("new reminders start unnotified", () => {
    const store = new ReminderStore(":memory:");
    const record = store.create({ text: "Task", dueAt: "2026-09-19T18:00:00.000Z" });

    expect(record.notifiedAt).toBeNull();
    store.close();
  });

  test("getDueUnnotified finds a due, unnotified reminder", () => {
    const store = new ReminderStore(":memory:");
    store.create({ text: "Task", dueAt: "2026-01-15T08:00:00.000Z" });

    const due = store.getDueUnnotified("2026-01-15T09:00:00.000Z");
    expect(due).toHaveLength(1);
    store.close();
  });

  test("getDueUnnotified excludes a reminder not yet due", () => {
    const store = new ReminderStore(":memory:");
    store.create({ text: "Task", dueAt: "2026-01-15T10:00:00.000Z" });

    const due = store.getDueUnnotified("2026-01-15T09:00:00.000Z");
    expect(due).toHaveLength(0);
    store.close();
  });

  test("create() canonicalizes a non-Z ISO offset dueAt to UTC, so it stays comparable to nowIso as raw text", () => {
    // "+02:00" denotes the same instant as "...T07:00:00.000Z" but is not
    // lexicographically comparable to a canonical "Z" timestamp the way
    // getDueUnnotified/nowIso always are — storing it verbatim would make
    // an actually-overdue reminder silently never match `dueAt <= nowIso`.
    const store = new ReminderStore(":memory:");
    const record = store.create({ text: "Task", dueAt: "2026-01-15T09:00:00+02:00" });

    expect(record.dueAt).toBe("2026-01-15T07:00:00.000Z");

    const due = store.getDueUnnotified("2026-01-15T08:00:00.000Z");
    expect(due).toHaveLength(1);
    store.close();
  });

  test("update() canonicalizes a non-Z ISO offset dueAt to UTC the same way", () => {
    const store = new ReminderStore(":memory:");
    const record = store.create({ text: "Task", dueAt: "2026-01-15T08:00:00.000Z" });

    const updated = store.update(record.id, { dueAt: "2026-01-15T09:00:00+02:00" });

    expect(updated?.dueAt).toBe("2026-01-15T07:00:00.000Z");
    store.close();
  });

  test("getDueUnnotified excludes an undated reminder", () => {
    const store = new ReminderStore(":memory:");
    store.create({ text: "Task" });

    const due = store.getDueUnnotified("2026-01-15T09:00:00.000Z");
    expect(due).toHaveLength(0);
    store.close();
  });

  test("markNotified excludes the reminder from further getDueUnnotified results", () => {
    const store = new ReminderStore(":memory:");
    const record = store.create({ text: "Task", dueAt: "2026-01-15T08:00:00.000Z" });

    store.markNotified(record.id, "2026-01-15T09:00:00.000Z");

    expect(store.getDueUnnotified("2026-01-15T09:00:00.000Z")).toHaveLength(0);
    expect(store.get(record.id)?.notifiedAt).toBe("2026-01-15T09:00:00.000Z");
    store.close();
  });

  test("update to a new dueAt clears notifiedAt so it can notify again", () => {
    const store = new ReminderStore(":memory:");
    const record = store.create({ text: "Task", dueAt: "2026-01-15T08:00:00.000Z" });
    store.markNotified(record.id, "2026-01-15T09:00:00.000Z");

    const updated = store.update(record.id, { dueAt: "2026-01-16T08:00:00.000Z" });

    expect(updated?.notifiedAt).toBeNull();
    expect(store.getDueUnnotified("2026-01-16T09:00:00.000Z")).toHaveLength(1);
    store.close();
  });

  test("update that doesn't change dueAt preserves notifiedAt", () => {
    const store = new ReminderStore(":memory:");
    const record = store.create({ text: "Task", dueAt: "2026-01-15T08:00:00.000Z" });
    store.markNotified(record.id, "2026-01-15T09:00:00.000Z");

    const updated = store.update(record.id, { text: "Updated task" });

    expect(updated?.notifiedAt).toBe("2026-01-15T09:00:00.000Z");
    store.close();
  });
});
