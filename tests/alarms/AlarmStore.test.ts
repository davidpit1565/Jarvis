import { describe, test, expect } from "bun:test";
import { AlarmStore, isValidTimeOfDay } from "@/alarms/AlarmStore";

describe("isValidTimeOfDay", () => {
  test.each([
    ["07:00", true],
    ["23:59", true],
    ["00:00", true],
    ["24:00", false],
    ["7:00", false],
    ["07:60", false],
    ["not-a-time", false],
    ["", false],
  ])("%s -> %s", (value, expected) => {
    expect(isValidTimeOfDay(value)).toBe(expected);
  });
});

describe("AlarmStore", () => {
  test("creates an alarm with defaults", () => {
    const store = new AlarmStore(":memory:");
    const record = store.create({ timeOfDay: "07:00" });

    expect(record.timeOfDay).toBe("07:00");
    expect(record.label).toBeNull();
    expect(record.enabled).toBe(true);
    expect(record.lastTriggeredDate).toBeNull();
    store.close();
  });

  test("throws on an invalid timeOfDay", () => {
    const store = new AlarmStore(":memory:");
    expect(() => store.create({ timeOfDay: "25:99" })).toThrow();
    store.close();
  });

  test("lists alarms sorted by time of day", () => {
    const store = new AlarmStore(":memory:");
    store.create({ timeOfDay: "18:00" });
    store.create({ timeOfDay: "07:00" });

    const times = store.list().map((a) => a.timeOfDay);
    expect(times).toEqual(["07:00", "18:00"]);
    store.close();
  });

  test("delete removes an alarm", () => {
    const store = new AlarmStore(":memory:");
    const record = store.create({ timeOfDay: "07:00" });

    expect(store.delete(record.id)).toBe(true);
    expect(store.list()).toEqual([]);
    store.close();
  });

  test("delete returns false for an unknown id", () => {
    const store = new AlarmStore(":memory:");
    expect(store.delete("does-not-exist")).toBe(false);
    store.close();
  });

  test("markTriggered records the date the alarm last fired", () => {
    const store = new AlarmStore(":memory:");
    const record = store.create({ timeOfDay: "07:00" });

    store.markTriggered(record.id, "2026-01-15");

    const [updated] = store.list();
    expect(updated?.lastTriggeredDate).toBe("2026-01-15");
    store.close();
  });

  test("update edits timeOfDay and/or label in place", () => {
    const store = new AlarmStore(":memory:");
    const record = store.create({ timeOfDay: "07:00", label: "gym" });

    const updated = store.update(record.id, { timeOfDay: "08:00" });
    expect(updated?.timeOfDay).toBe("08:00");
    expect(updated?.label).toBe("gym"); // unchanged

    const updatedAgain = store.update(record.id, { label: "later" });
    expect(updatedAgain?.timeOfDay).toBe("08:00"); // unchanged
    expect(updatedAgain?.label).toBe("later");
    store.close();
  });

  test("update preserves lastTriggeredDate when timeOfDay is unchanged", () => {
    const store = new AlarmStore(":memory:");
    const record = store.create({ timeOfDay: "07:00" });
    store.markTriggered(record.id, "2026-01-15");

    const updated = store.update(record.id, { label: "later" });
    expect(updated?.timeOfDay).toBe("07:00");
    expect(store.list()[0]?.lastTriggeredDate).toBe("2026-01-15");
    store.close();
  });

  test("update resets lastTriggeredDate when timeOfDay actually changes, so a same-day reschedule can still fire today", () => {
    const store = new AlarmStore(":memory:");
    const record = store.create({ timeOfDay: "07:00" });
    store.markTriggered(record.id, "2026-01-15");

    const updated = store.update(record.id, { timeOfDay: "20:00" });
    expect(updated?.timeOfDay).toBe("20:00");
    expect(updated?.lastTriggeredDate).toBeNull();
    expect(store.list()[0]?.lastTriggeredDate).toBeNull();
    store.close();
  });

  test("update returns null for an unknown id", () => {
    const store = new AlarmStore(":memory:");
    expect(store.update("does-not-exist", { timeOfDay: "08:00" })).toBeNull();
    store.close();
  });

  test("update can toggle enabled without changing timeOfDay/label", () => {
    const store = new AlarmStore(":memory:");
    const record = store.create({ timeOfDay: "07:00", label: "gym" });

    const disabled = store.update(record.id, { enabled: false });
    expect(disabled?.enabled).toBe(false);
    expect(disabled?.timeOfDay).toBe("07:00");
    expect(disabled?.label).toBe("gym");

    const reEnabled = store.update(record.id, { enabled: true });
    expect(reEnabled?.enabled).toBe(true);
    store.close();
  });

  test("update persists the enabled change to the backing store", () => {
    const store = new AlarmStore(":memory:");
    const record = store.create({ timeOfDay: "07:00" });
    store.update(record.id, { enabled: false });

    expect(store.list()[0]?.enabled).toBe(false);
    store.close();
  });

  test("update throws on an invalid timeOfDay", () => {
    const store = new AlarmStore(":memory:");
    const record = store.create({ timeOfDay: "07:00" });
    expect(() => store.update(record.id, { timeOfDay: "99:99" })).toThrow();
    store.close();
  });

  test("survives across instances backed by the same SQLite file", () => {
    const dbPath = `/tmp/jarvis-alarm-test-${crypto.randomUUID()}.sqlite`;

    const first = new AlarmStore(dbPath);
    first.create({ timeOfDay: "07:00", label: "gym" });
    first.close();

    const second = new AlarmStore(dbPath);
    const [record] = second.list();
    expect(record?.label).toBe("gym");
    second.close();
  });
});
