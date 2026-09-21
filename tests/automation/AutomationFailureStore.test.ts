import { describe, test, expect } from "bun:test";
import { AutomationFailureStore } from "@/automation/AutomationFailureStore";

describe("AutomationFailureStore", () => {
  test("starts empty", () => {
    const store = new AutomationFailureStore(":memory:");
    expect(store.list()).toEqual([]);
    store.close();
  });

  test("records a failure and lists it back, most recent first", () => {
    const store = new AutomationFailureStore(":memory:");
    store.record("rule-1", "Send me the weekly digest", "Telegram API returned 500");
    store.record("rule-2", "Turn off the lights", "Device offline");

    const entries = store.list();
    expect(entries).toHaveLength(2);
    expect(entries[0]!.ruleId).toBe("rule-2");
    expect(entries[0]!.error).toBe("Device offline");
    expect(entries[1]!.ruleId).toBe("rule-1");
    expect(entries[1]!.timestamp).toBeTruthy();
    store.close();
  });

  test("respects a limit passed to list()", () => {
    const store = new AutomationFailureStore(":memory:");
    for (let i = 0; i < 5; i++) {
      store.record(`rule-${i}`, "instruction", "error");
    }
    expect(store.list(2)).toHaveLength(2);
    store.close();
  });

  test("prunes old rows past its retention cap", () => {
    const store = new AutomationFailureStore(":memory:");
    for (let i = 0; i < 505; i++) {
      store.record(`rule-${i}`, "instruction", "error");
    }
    // list() itself defaults to 50, so ask for more than the cap to prove
    // pruning actually happened rather than just not being requested.
    expect(store.list(1000).length).toBeLessThanOrEqual(500);
    store.close();
  });

  test("persists across reopening the same file", () => {
    const path = `/tmp/jarvis-automation-failures-test-${crypto.randomUUID()}.sqlite`;
    const store1 = new AutomationFailureStore(path);
    store1.record("rule-x", "do the thing", "boom");
    store1.close();

    const store2 = new AutomationFailureStore(path);
    expect(store2.list()).toHaveLength(1);
    store2.close();
  });
});
