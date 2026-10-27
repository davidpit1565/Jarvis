import type { WatchSource } from "@/watcher/WatchSource";
import type { WatcherStore } from "@/watcher/WatcherStore";

/**
 * Generic, capped/bounded proactive note across a set of registered
 * `WatchSource`s — reads `store` only (zero network calls), the same
 * synchronous-cache-read discipline `githubActivityNote`/`goalProgressNote`
 * already follow. `src/news/newsWatchSources.ts` uses this directly.
 *
 * `githubActivityNote.ts` is deliberately NOT rebuilt on top of this
 * function — GitHub's note groups items by category (commits/issues/PRs)
 * with per-category counts ("3 new commit(s): ..."), which predates this
 * generic interface and whose exact wording its own tests assert; forcing
 * it through a flat per-item composer would either break that wording for
 * no real benefit or require this composer to grow category-grouping
 * knowledge it has no business having for an arbitrary `WatchSource`. What
 * IS shared between them: `GitHubActivityStore` now persists through the
 * same `WatcherStore` engine this composer reads (see that file's doc
 * comment) — the storage layer is unified even though GitHub keeps its own
 * note formatter.
 *
 * Capping is two-level, same shape as `githubActivityNote`'s
 * MAX_REPOS_IN_NOTE/MAX_ITEMS_PER_REPO: at most `maxSources` sources shown,
 * each with at most `maxItemsPerSource` items, with an honest "+N more"
 * for whatever's left out at either level — never silently dropped,
 * never unbounded.
 */
const DEFAULT_MAX_SOURCES = 3;
const DEFAULT_MAX_ITEMS_PER_SOURCE = 3;

export interface ComposeWatcherNoteOptions {
  maxSources?: number;
  maxItemsPerSource?: number;
  /** The note's opening sentence, given the total number of sources with new activity. */
  intro: (sourceCount: number) => string;
}

export function composeWatcherNote<TCursor, TItem>(
  store: WatcherStore,
  sources: Array<WatchSource<TCursor, TItem>>,
  options: ComposeWatcherNoteOptions
): string | undefined {
  const maxSources = options.maxSources ?? DEFAULT_MAX_SOURCES;
  const maxItemsPerSource = options.maxItemsPerSource ?? DEFAULT_MAX_ITEMS_PER_SOURCE;

  const byId = new Map(sources.map((source) => [source.id, source]));
  const activity = store
    .listWithActivity<TItem>()
    .filter((record) => byId.has(record.sourceId));

  if (activity.length === 0) return undefined;

  const shownRecords = activity.slice(0, maxSources);
  const omittedSources = activity.length - shownRecords.length;

  const lines = shownRecords.map((record) => {
    const source = byId.get(record.sourceId)!;
    const shownItems = record.newItems.slice(0, maxItemsPerSource);
    const omittedItems = record.newItems.length - shownItems.length;
    const descriptions = shownItems.map((item) => source.describe(item)).join(", ");
    const omittedNote = omittedItems > 0 ? ` (plus ${omittedItems} more not shown)` : "";
    return `- ${source.label} — ${record.newItems.length} new item(s): ${descriptions}${omittedNote}`;
  });

  const omittedSourcesNote = omittedSources > 0 ? ` (plus ${omittedSources} more source(s) with new activity not shown)` : "";
  return `${options.intro(activity.length)}${omittedSourcesNote}:\n${lines.join("\n")}`;
}
