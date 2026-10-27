import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { WatcherStore } from "@/watcher/WatcherStore";
import { composeWatcherNote } from "@/watcher/watcherNote";
import type { WatchSource } from "@/watcher/WatchSource";

function makeSource(id: string, label: string): WatchSource<unknown, string> {
  return {
    id,
    label,
    poll: async () => ({ newItems: [], nextCursor: undefined }),
    describe: (item) => item,
  };
}

describe("composeWatcherNote", () => {
  let store: WatcherStore;

  beforeEach(() => {
    store = new WatcherStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("returns undefined when nothing is cached", () => {
    const sources = [makeSource("s1", "Source One")];
    expect(composeWatcherNote(store, sources, { intro: () => "intro" })).toBeUndefined();
  });

  test("returns undefined when every source's latest poll found nothing new", () => {
    const sources = [makeSource("s1", "Source One")];
    store.recordPoll("s1", undefined, []);
    expect(composeWatcherNote(store, sources, { intro: () => "intro" })).toBeUndefined();
  });

  test("composes a line per source with activity, using the source's own describe()", () => {
    const sources = [makeSource("s1", "Source One")];
    store.recordPoll("s1", undefined, ["item a", "item b"]);

    const note = composeWatcherNote(store, sources, { intro: (n) => `${n} source(s) updated` })!;
    expect(note).toContain("1 source(s) updated");
    expect(note).toContain("Source One");
    expect(note).toContain("item a");
    expect(note).toContain("item b");
  });

  test("ignores store records for sources not in the given list", () => {
    const sources = [makeSource("s1", "Source One")];
    store.recordPoll("s1", undefined, ["a"]);
    store.recordPoll("unrelated", undefined, ["b"]);

    const note = composeWatcherNote(store, sources, { intro: () => "intro" })!;
    expect(note).toContain("1 source(s)".replace("1 source(s)", "Source One")); // sanity: only s1 label present
    expect(note).not.toContain("unrelated");
    expect(note).not.toContain('"b"');
  });

  test("caps items per source with an honest '+N more' note", () => {
    const sources = [makeSource("s1", "Source One")];
    store.recordPoll("s1", undefined, ["a", "b", "c", "d", "e"]);

    const note = composeWatcherNote(store, sources, { intro: () => "intro", maxItemsPerSource: 3 })!;
    expect(note).toContain("5 new item(s)");
    expect(note).toMatch(/plus 2 more not shown/);
  });

  test("caps the number of sources shown with an honest '+N more source(s)' note", () => {
    const sources = Array.from({ length: 6 }, (_, i) => makeSource(`s${i}`, `Source ${i}`));
    for (const source of sources) {
      store.recordPoll(source.id, undefined, [`item for ${source.id}`]);
    }

    const note = composeWatcherNote(store, sources, { intro: (n) => `${n} total`, maxSources: 3 })!;
    expect(note).toContain("6 total");
    const bulletLines = note.split("\n").filter((line) => line.startsWith("- "));
    expect(bulletLines.length).toBe(3);
    expect(note).toMatch(/plus 3 more source\(s\) with new activity not shown/);
  });
});
