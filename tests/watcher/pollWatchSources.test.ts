import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { WatcherStore } from "@/watcher/WatcherStore";
import { pollWatchSources } from "@/watcher/pollWatchSources";
import type { WatchSource } from "@/watcher/WatchSource";

function makeSource(
  id: string,
  pollImpl: (previousCursor: number | undefined) => Promise<{ newItems: string[]; nextCursor: number }>
): WatchSource<number, string> {
  return { id, label: id, poll: pollImpl, describe: (item) => item };
}

describe("pollWatchSources", () => {
  let store: WatcherStore;

  beforeEach(() => {
    store = new WatcherStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("a first poll establishes a baseline and records whatever the source reports", async () => {
    const source = makeSource("s1", async (prev) => {
      expect(prev).toBeUndefined();
      return { newItems: ["a", "b"], nextCursor: 2 };
    });

    await pollWatchSources([source], store);

    expect(store.getCursor<number>("s1")).toBe(2);
    expect(store.listWithActivity()[0]!.newItems).toEqual(["a", "b"]);
  });

  test("passes the previously recorded cursor into the next poll — no double-counting", async () => {
    let calls = 0;
    const source = makeSource("s1", async (prev) => {
      calls++;
      if (calls === 1) return { newItems: ["a"], nextCursor: 1 };
      expect(prev).toBe(1);
      return { newItems: ["b"], nextCursor: 2 };
    });

    await pollWatchSources([source], store);
    await pollWatchSources([source], store);

    expect(calls).toBe(2);
    // Second poll's result replaces the first's — only "b" is "new" now.
    expect(store.listWithActivity()[0]!.newItems).toEqual(["b"]);
  });

  test("a failing source is isolated: reported via onError, doesn't touch its cached state, doesn't stop other sources", async () => {
    const good = makeSource("good", async () => ({ newItems: ["ok"], nextCursor: 1 }));
    const bad = makeSource("bad", async () => {
      throw new Error("boom");
    });
    store.recordPoll("bad", 0, []);

    const errors: Array<{ sourceId: string; error: unknown }> = [];
    await pollWatchSources([good, bad], store, (sourceId, error) => errors.push({ sourceId, error }));

    expect(errors).toHaveLength(1);
    expect(errors[0]!.sourceId).toBe("bad");
    expect(store.getCursor<number>("bad")).toBe(0);
    expect(store.getCursor<number>("good")).toBe(1);
  });

  test("never throws even when every source fails", async () => {
    const bad = makeSource("bad", async () => {
      throw new Error("boom");
    });
    await expect(pollWatchSources([bad], store, () => {})).resolves.toBeUndefined();
  });
});
