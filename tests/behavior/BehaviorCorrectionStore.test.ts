import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { BehaviorCorrectionStore } from "@/behavior/BehaviorCorrectionStore";

describe("BehaviorCorrectionStore", () => {
  let store: BehaviorCorrectionStore;

  beforeEach(() => {
    store = new BehaviorCorrectionStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("stores a correction and retrieves it by id", () => {
    const record = store.add({
      contextKey: "CREATE_REMINDER",
      correction: "ask for a specific time instead of assuming morning",
      originalAction: "CREATE_REMINDER",
      triggeringMessage: "no, I meant 6pm not 6am",
    });

    expect(record.id).toBeTruthy();
    expect(record.source).toBe("BACKGROUND_INFERRED");
    expect(record.flaggedPreferenceConflict).toBe(false);
    expect(store.get(record.id)).toEqual(record);
  });

  test("listForContext returns corrections for one context key, newest first", () => {
    store.add({
      contextKey: "CREATE_REMINDER",
      correction: "first correction",
      originalAction: "CREATE_REMINDER",
      triggeringMessage: "no",
    });
    store.add({
      contextKey: "CREATE_REMINDER",
      correction: "second correction",
      originalAction: "CREATE_REMINDER",
      triggeringMessage: "no again",
    });
    store.add({
      contextKey: "SEND_EMAIL",
      correction: "unrelated correction",
      originalAction: "SEND_EMAIL",
      triggeringMessage: "no",
    });

    const list = store.listForContext("CREATE_REMINDER");
    expect(list).toHaveLength(2);
    expect(list[0]?.correction).toBe("second correction");
    expect(list[1]?.correction).toBe("first correction");
  });

  test("enforces a per-context cap, keeping only the newest rows", () => {
    for (let i = 0; i < 12; i++) {
      store.add({
        contextKey: "CREATE_REMINDER",
        correction: `correction ${i}`,
        originalAction: "CREATE_REMINDER",
        triggeringMessage: "no",
      });
    }

    const all = store.listForContext("CREATE_REMINDER");
    expect(all.length).toBeLessThanOrEqual(8);
    // The newest ones survive — the very last one added must still be there.
    expect(all.map((r) => r.correction)).toContain("correction 11");
    // The earliest ones are gone.
    expect(all.map((r) => r.correction)).not.toContain("correction 0");
  });

  test("a cap on one context key never affects another context key's rows", () => {
    for (let i = 0; i < 10; i++) {
      store.add({
        contextKey: "CREATE_REMINDER",
        correction: `reminder correction ${i}`,
        originalAction: "CREATE_REMINDER",
        triggeringMessage: "no",
      });
    }
    store.add({
      contextKey: "SEND_EMAIL",
      correction: "email correction",
      originalAction: "SEND_EMAIL",
      triggeringMessage: "no",
    });

    expect(store.listForContext("SEND_EMAIL")).toHaveLength(1);
  });

  test("listRelevant returns matches across multiple context keys, newest first, bounded", () => {
    store.add({
      contextKey: "CREATE_REMINDER",
      correction: "reminder correction",
      originalAction: "CREATE_REMINDER",
      triggeringMessage: "no",
    });
    store.add({
      contextKey: "LIST_REMINDERS",
      correction: "listing correction",
      originalAction: "LIST_REMINDERS",
      triggeringMessage: "no",
    });
    store.add({
      contextKey: "SEND_EMAIL",
      correction: "unrelated correction",
      originalAction: "SEND_EMAIL",
      triggeringMessage: "no",
    });

    const relevant = store.listRelevant(["CREATE_REMINDER", "LIST_REMINDERS"]);
    expect(relevant).toHaveLength(2);
    expect(relevant.map((r) => r.contextKey).sort()).toEqual(["CREATE_REMINDER", "LIST_REMINDERS"]);
  });

  test("listRelevant with an empty context key list returns nothing, never guesses", () => {
    store.add({
      contextKey: "CREATE_REMINDER",
      correction: "reminder correction",
      originalAction: "CREATE_REMINDER",
      triggeringMessage: "no",
    });

    expect(store.listRelevant([])).toEqual([]);
  });

  test("listRelevant is bounded even when many rows match and a larger limit is requested", () => {
    for (let i = 0; i < 8; i++) {
      store.add({
        contextKey: "CREATE_REMINDER",
        correction: `correction ${i}`,
        originalAction: "CREATE_REMINDER",
        triggeringMessage: "no",
      });
    }

    const relevant = store.listRelevant(["CREATE_REMINDER"], 100);
    expect(relevant.length).toBeLessThanOrEqual(5);
  });

  test("stores a flagged preference conflict with its conflicting text", () => {
    const record = store.add({
      contextKey: "SEND_EMAIL",
      correction: "always cc my assistant on outgoing emails",
      originalAction: "SEND_EMAIL",
      triggeringMessage: "cc my assistant on that from now on",
      flaggedPreferenceConflict: true,
      conflictingPreference: "never cc anyone else on my emails without asking first",
    });

    expect(record.flaggedPreferenceConflict).toBe(true);
    expect(record.conflictingPreference).toBe("never cc anyone else on my emails without asking first");
    expect(store.get(record.id)?.flaggedPreferenceConflict).toBe(true);
  });

  test("delete removes a correction by id", () => {
    const record = store.add({
      contextKey: "CREATE_REMINDER",
      correction: "x",
      originalAction: "CREATE_REMINDER",
      triggeringMessage: "no",
    });

    expect(store.delete(record.id)).toBe(true);
    expect(store.get(record.id)).toBeNull();
  });
});
