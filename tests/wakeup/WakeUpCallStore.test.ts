import { describe, test, expect } from "bun:test";
import { WakeUpCallStore, isValidTimeOfDay } from "@/wakeup/WakeUpCallStore";

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

describe("WakeUpCallStore", () => {
  test("creates a call with defaults", () => {
    const store = new WakeUpCallStore(":memory:");
    const record = store.create({ timeOfDay: "07:00" });

    expect(record.timeOfDay).toBe("07:00");
    expect(record.label).toBeNull();
    expect(record.enabled).toBe(true);
    expect(record.lastTriggeredDate).toBeNull();
    store.close();
  });

  test("throws on an invalid timeOfDay", () => {
    const store = new WakeUpCallStore(":memory:");
    expect(() => store.create({ timeOfDay: "25:99" })).toThrow();
    store.close();
  });

  test("lists calls sorted by time of day", () => {
    const store = new WakeUpCallStore(":memory:");
    store.create({ timeOfDay: "18:00" });
    store.create({ timeOfDay: "07:00" });

    const times = store.list().map((c) => c.timeOfDay);
    expect(times).toEqual(["07:00", "18:00"]);
    store.close();
  });

  test("delete removes a call", () => {
    const store = new WakeUpCallStore(":memory:");
    const record = store.create({ timeOfDay: "07:00" });

    expect(store.delete(record.id)).toBe(true);
    expect(store.list()).toEqual([]);
    store.close();
  });

  test("delete returns false for an unknown id", () => {
    const store = new WakeUpCallStore(":memory:");
    expect(store.delete("does-not-exist")).toBe(false);
    store.close();
  });

  test("markTriggered records the date the call last went out", () => {
    const store = new WakeUpCallStore(":memory:");
    const record = store.create({ timeOfDay: "07:00" });

    store.markTriggered(record.id, "2026-01-15");

    const [updated] = store.list();
    expect(updated?.lastTriggeredDate).toBe("2026-01-15");
    store.close();
  });

  test("survives across instances backed by the same SQLite file", () => {
    const dbPath = `/tmp/jarvis-wakeup-test-${crypto.randomUUID()}.sqlite`;

    const first = new WakeUpCallStore(dbPath);
    first.create({ timeOfDay: "07:00", label: "weekday" });
    first.close();

    const second = new WakeUpCallStore(dbPath);
    const [record] = second.list();
    expect(record?.label).toBe("weekday");
    second.close();
  });
});
