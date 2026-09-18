import { describe, test, expect } from "bun:test";
import { ReminderStore } from "@/reminders/ReminderStore";
import { buildContextNote } from "@/core/buildContextNote";

describe("buildContextNote", () => {
  test("always includes the current time note", () => {
    const store = new ReminderStore(":memory:");
    const note = buildContextNote({ timezone: "UTC" }, store);
    expect(note).toContain("Current date/time");
    store.close();
  });

  test("includes due reminders when present", () => {
    const store = new ReminderStore(":memory:");
    store.create({ text: "Overdue task", dueAt: "2020-01-01T00:00:00.000Z" });
    const note = buildContextNote({ timezone: "UTC" }, store);
    expect(note).toContain("Overdue task");
    store.close();
  });

  test("omits the reminders section entirely when there are none due", () => {
    const store = new ReminderStore(":memory:");
    const note = buildContextNote({ timezone: "UTC" }, store);
    expect(note).not.toContain("reminder(s) due");
    store.close();
  });
});
