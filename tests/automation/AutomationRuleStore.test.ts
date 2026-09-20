import { describe, test, expect } from "bun:test";
import { AutomationRuleStore } from "@/automation/AutomationRuleStore";

describe("AutomationRuleStore", () => {
  test("creates a rule with defaults", () => {
    const store = new AutomationRuleStore(":memory:");
    const record = store.create({ timeOfDay: "08:00", instruction: "check the weather" });

    expect(record.timeOfDay).toBe("08:00");
    expect(record.instruction).toBe("check the weather");
    expect(record.enabled).toBe(true);
    expect(record.lastTriggeredDate).toBeNull();
    store.close();
  });

  test("throws on an invalid timeOfDay", () => {
    const store = new AutomationRuleStore(":memory:");
    expect(() => store.create({ timeOfDay: "25:99", instruction: "check the weather" })).toThrow();
    store.close();
  });

  test("throws on an empty instruction", () => {
    const store = new AutomationRuleStore(":memory:");
    expect(() => store.create({ timeOfDay: "08:00", instruction: "   " })).toThrow();
    store.close();
  });

  test("throws on an instruction that's too long", () => {
    const store = new AutomationRuleStore(":memory:");
    expect(() => store.create({ timeOfDay: "08:00", instruction: "x".repeat(2001) })).toThrow();
    store.close();
  });

  test("lists rules sorted by time of day", () => {
    const store = new AutomationRuleStore(":memory:");
    store.create({ timeOfDay: "18:00", instruction: "evening summary" });
    store.create({ timeOfDay: "07:00", instruction: "morning summary" });

    const times = store.list().map((r) => r.timeOfDay);
    expect(times).toEqual(["07:00", "18:00"]);
    store.close();
  });

  test("delete removes a rule", () => {
    const store = new AutomationRuleStore(":memory:");
    const record = store.create({ timeOfDay: "08:00", instruction: "check the weather" });

    expect(store.delete(record.id)).toBe(true);
    expect(store.list()).toEqual([]);
    store.close();
  });

  test("delete returns false for an unknown id", () => {
    const store = new AutomationRuleStore(":memory:");
    expect(store.delete("does-not-exist")).toBe(false);
    store.close();
  });

  test("markTriggered records the date the rule last ran", () => {
    const store = new AutomationRuleStore(":memory:");
    const record = store.create({ timeOfDay: "08:00", instruction: "check the weather" });

    store.markTriggered(record.id, "2026-01-15");

    const [updated] = store.list();
    expect(updated?.lastTriggeredDate).toBe("2026-01-15");
    store.close();
  });

  test("update edits timeOfDay and/or instruction in place", () => {
    const store = new AutomationRuleStore(":memory:");
    const record = store.create({ timeOfDay: "08:00", instruction: "check the weather" });

    const updated = store.update(record.id, { timeOfDay: "09:00" });
    expect(updated?.timeOfDay).toBe("09:00");
    expect(updated?.instruction).toBe("check the weather"); // unchanged

    const updatedAgain = store.update(record.id, { instruction: "check the news" });
    expect(updatedAgain?.timeOfDay).toBe("09:00"); // unchanged
    expect(updatedAgain?.instruction).toBe("check the news");
    store.close();
  });

  test("update preserves lastTriggeredDate", () => {
    const store = new AutomationRuleStore(":memory:");
    const record = store.create({ timeOfDay: "08:00", instruction: "check the weather" });
    store.markTriggered(record.id, "2026-01-15");

    const updated = store.update(record.id, { timeOfDay: "09:00" });
    expect(updated?.timeOfDay).toBe("09:00");
    expect(store.list()[0]?.lastTriggeredDate).toBe("2026-01-15");
    store.close();
  });

  test("update returns null for an unknown id", () => {
    const store = new AutomationRuleStore(":memory:");
    expect(store.update("does-not-exist", { timeOfDay: "09:00" })).toBeNull();
    store.close();
  });

  test("update can toggle enabled without changing timeOfDay/instruction", () => {
    const store = new AutomationRuleStore(":memory:");
    const record = store.create({ timeOfDay: "08:00", instruction: "check the weather" });

    const disabled = store.update(record.id, { enabled: false });
    expect(disabled?.enabled).toBe(false);
    expect(disabled?.timeOfDay).toBe("08:00");

    const reEnabled = store.update(record.id, { enabled: true });
    expect(reEnabled?.enabled).toBe(true);
    store.close();
  });

  test("update throws on an invalid timeOfDay", () => {
    const store = new AutomationRuleStore(":memory:");
    const record = store.create({ timeOfDay: "08:00", instruction: "check the weather" });
    expect(() => store.update(record.id, { timeOfDay: "99:99" })).toThrow();
    store.close();
  });

  test("update throws on an empty instruction", () => {
    const store = new AutomationRuleStore(":memory:");
    const record = store.create({ timeOfDay: "08:00", instruction: "check the weather" });
    expect(() => store.update(record.id, { instruction: "  " })).toThrow();
    store.close();
  });

  test("survives across instances backed by the same SQLite file", () => {
    const dbPath = `/tmp/jarvis-automation-rules-test-${crypto.randomUUID()}.sqlite`;

    const first = new AutomationRuleStore(dbPath);
    first.create({ timeOfDay: "08:00", instruction: "check the weather" });
    first.close();

    const second = new AutomationRuleStore(dbPath);
    const [record] = second.list();
    expect(record?.instruction).toBe("check the weather");
    second.close();
  });
});
