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
});
