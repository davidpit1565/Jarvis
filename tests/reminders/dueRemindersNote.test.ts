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

  test("includes a reminder due within the upcoming window as 'coming up soon'", () => {
    const store = new ReminderStore(":memory:");
    const soon = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min from now
    store.create({ text: "Dentist appointment", dueAt: soon });

    const note = dueRemindersNote(store);
    expect(note).toContain("Dentist appointment");
    expect(note).toContain("coming up soon");
    store.close();
  });

  test("excludes a reminder further out than the upcoming window", () => {
    const store = new ReminderStore(":memory:");
    const farFuture = new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString(); // 5 hours from now
    store.create({ text: "Far future task", dueAt: farFuture });

    expect(dueRemindersNote(store)).toBeUndefined();
    store.close();
  });

  test("respects a custom upcomingWindowMs", () => {
    const store = new ReminderStore(":memory:");
    const inTwoHours = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    store.create({ text: "Two hour task", dueAt: inTwoHours });

    expect(dueRemindersNote(store)).toBeUndefined();
    const note = dueRemindersNote(store, 3 * 60 * 60 * 1000);
    expect(note).toContain("Two hour task");
    store.close();
  });

  test("shows both overdue and upcoming sections separately when both exist", () => {
    const store = new ReminderStore(":memory:");
    store.create({ text: "Overdue task", dueAt: "2020-01-01T00:00:00.000Z" });
    const soon = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    store.create({ text: "Upcoming task", dueAt: soon });

    const note = dueRemindersNote(store);
    expect(note).toContain("Overdue task");
    expect(note).toContain("Upcoming task");
    expect(note).toContain("due now or overdue");
    expect(note).toContain("coming up soon");
    store.close();
  });
});
