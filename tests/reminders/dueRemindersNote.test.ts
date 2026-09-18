import { describe, test, expect } from "bun:test";
import { ReminderStore } from "@/reminders/ReminderStore";
import { dueRemindersNote } from "@/reminders/dueRemindersNote";

describe("dueRemindersNote", () => {
  test("returns undefined when there are no reminders", () => {
    const store = new ReminderStore(":memory:");
    expect(dueRemindersNote(store)).toBeUndefined();
    store.close();
  });

  test("returns undefined when reminders exist but none are due yet", () => {
    const store = new ReminderStore(":memory:");
    store.create({ text: "Future task", dueAt: "2099-01-01T00:00:00.000Z" });
    expect(dueRemindersNote(store)).toBeUndefined();
    store.close();
  });

  test("returns undefined for undated reminders — they're never 'due'", () => {
    const store = new ReminderStore(":memory:");
    store.create({ text: "Someday task" });
    expect(dueRemindersNote(store)).toBeUndefined();
    store.close();
  });

  test("includes an overdue reminder", () => {
    const store = new ReminderStore(":memory:");
    store.create({ text: "Call the dentist", dueAt: "2020-01-01T00:00:00.000Z" });
    const note = dueRemindersNote(store);
    expect(note).toContain("Call the dentist");
    expect(note).toContain("1 reminder(s)");
    store.close();
  });

  test("excludes a completed reminder even if overdue", () => {
    const store = new ReminderStore(":memory:");
    const record = store.create({ text: "Old task", dueAt: "2020-01-01T00:00:00.000Z" });
    store.complete(record.id);
    expect(dueRemindersNote(store)).toBeUndefined();
    store.close();
  });

  test("counts multiple due reminders", () => {
    const store = new ReminderStore(":memory:");
    store.create({ text: "Task A", dueAt: "2020-01-01T00:00:00.000Z" });
    store.create({ text: "Task B", dueAt: "2020-01-02T00:00:00.000Z" });
    const note = dueRemindersNote(store);
    expect(note).toContain("2 reminder(s)");
    expect(note).toContain("Task A");
    expect(note).toContain("Task B");
    store.close();
  });
});
