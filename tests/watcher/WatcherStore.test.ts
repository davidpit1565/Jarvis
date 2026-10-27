import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { WatcherStore } from "@/watcher/WatcherStore";

describe("WatcherStore", () => {
  let store: WatcherStore;

  beforeEach(() => {
    store = new WatcherStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("getCursor returns undefined for a source that's never been polled", () => {
    expect(store.getCursor("x")).toBeUndefined();
  });

  test("listAll/listWithActivity are empty before anything is recorded", () => {
    expect(store.listAll()).toEqual([]);
    expect(store.listWithActivity()).toEqual([]);
  });

  test("recordPoll persists an opaque cursor and items, readable back", () => {
    store.recordPoll("s1", { foo: "bar" }, [{ a: 1 }, { a: 2 }], "2026-10-27T00:00:00Z");

    expect(store.getCursor<{ foo: string }>("s1")).toEqual({ foo: "bar" });
    const activity = store.listWithActivity();
    expect(activity).toHaveLength(1);
    expect(activity[0]).toEqual({ sourceId: "s1", newItems: [{ a: 1 }, { a: 2 }], polledAt: "2026-10-27T00:00:00Z" });
  });

  test("a source with an empty latest batch is excluded from listWithActivity but present in listAll", () => {
    store.recordPoll("s1", { x: 1 }, []);
    expect(store.listWithActivity()).toEqual([]);
    expect(store.listAll()).toHaveLength(1);
  });

  test("recordPoll overwrites the previous batch, no accumulation", () => {
    store.recordPoll("s1", {}, [{ v: 1 }]);
    expect(store.listWithActivity()[0]!.newItems).toEqual([{ v: 1 }]);

    store.recordPoll("s1", {}, [{ v: 2 }]);
    expect(store.listWithActivity()[0]!.newItems).toEqual([{ v: 2 }]);

    store.recordPoll("s1", {}, []);
    expect(store.listWithActivity()).toEqual([]);
  });

  test("tracks multiple sources independently", () => {
    store.recordPoll("a", {}, [{ v: 1 }]);
    store.recordPoll("b", {}, [{ v: 2 }]);
    const ids = store.listWithActivity().map((r) => r.sourceId).sort();
    expect(ids).toEqual(["a", "b"]);
  });

  test("listWithActivity orders most-recently-polled first", () => {
    store.recordPoll("old", {}, [{ v: 1 }], "2026-10-27T00:00:00Z");
    store.recordPoll("new", {}, [{ v: 2 }], "2026-10-27T01:00:00Z");
    const ids = store.listWithActivity().map((r) => r.sourceId);
    expect(ids).toEqual(["new", "old"]);
  });

  test("a cursor of undefined round-trips as undefined, not a crash", () => {
    store.recordPoll("s1", undefined, []);
    expect(store.getCursor("s1")).toBeUndefined();
  });
});
