import { describe, test, expect } from "bun:test";
import { ConversationHistoryStore } from "@/history/ConversationHistoryStore";

describe("ConversationHistoryStore", () => {
  test("records and finds a message by substring", () => {
    const store = new ConversationHistoryStore(":memory:");
    store.record("user", "What's the weather like in Tel Aviv?");

    const results = store.search("weather");
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toContain("Tel Aviv");
    expect(results[0]?.role).toBe("user");
    store.close();
  });

  test("search is case-insensitive", () => {
    const store = new ConversationHistoryStore(":memory:");
    store.record("assistant", "I saved that to memory.");

    expect(store.search("MEMORY")).toHaveLength(1);
    store.close();
  });

  test("returns no results when nothing matches", () => {
    const store = new ConversationHistoryStore(":memory:");
    store.record("user", "hello");

    expect(store.search("nonexistent")).toEqual([]);
    store.close();
  });

  test("most recent match first", () => {
    const store = new ConversationHistoryStore(":memory:");
    store.record("user", "first mention of apples");
    store.record("user", "second mention of apples");

    const results = store.search("apples");
    expect(results.map((r) => r.content)).toEqual(["second mention of apples", "first mention of apples"]);
    store.close();
  });

  test("respects the limit", () => {
    const store = new ConversationHistoryStore(":memory:");
    for (let i = 0; i < 5; i++) store.record("user", `banana ${i}`);

    expect(store.search("banana", 2)).toHaveLength(2);
    store.close();
  });

  test("ignores empty content (an assistant turn that only made tool calls)", () => {
    const store = new ConversationHistoryStore(":memory:");
    store.record("assistant", "");
    store.record("assistant", "   ");

    expect(store.search("")).toEqual([]);
    store.close();
  });
});
