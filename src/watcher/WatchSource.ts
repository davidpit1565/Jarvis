/**
 * A single pollable source of proactive information — a GitHub repo, a
 * news-topic watch, eventually a Gmail label/filter — generic over its own
 * cursor shape (`TCursor`, whatever "where did we leave off" means for this
 * source) and item shape (`TItem`, whatever one unit of new activity is).
 *
 * This is the shape `CLAUDE.md`'s "Approved for build: generalized
 * Proactive Watcher" spec asks for: the polling/caching/note-composition
 * machinery (`pollWatchSources.ts`, `WatcherStore.ts`, `watcherNote.ts`) is
 * written once against this interface, not once per source. GitHub's own
 * commit/issue/PR diffing predates this interface and keeps its own
 * specialized poll function (`pollGitHubActivity.ts` — see that file and
 * `GitHubActivityStore.ts`'s doc comments for why: three independent
 * per-category cursors and a note that groups by category, not a flat
 * item list), but now persists through the same `WatcherStore` engine
 * this interface's sources use directly. News (`src/news/newsWatchSources.ts`)
 * is the first source actually implemented against this interface.
 */
export interface WatchSource<TCursor, TItem> {
  /** Stable, globally-unique id for this source (e.g. "news:ai safety", "gmail:label/x") — the WatcherStore row key. */
  id: string;
  /** Human-readable label for notes/notifications (e.g. the topic/keyword, a repo's "owner/repo"). */
  label: string;
  /**
   * Whether this specific source warrants the louder device-announce
   * channel instead of the default quiet Telegram note — an explicit,
   * per-source config flag David sets up himself (see WatcherChannelRouter),
   * never a judgment call made per-item. Omitted/"default" for everything
   * unless explicitly configured otherwise.
   */
  priority?: "default" | "high";
  /**
   * Fetches whatever is new since `previousCursor` (undefined on a
   * source's first-ever poll — implementations should treat that as
   * "establish a baseline, report nothing as new," the same posture
   * `pollGitHubActivity`'s `diffCommits`/`diffByNumber` already take, to
   * avoid fabricating a burst of "new" activity out of a source's entire
   * pre-existing history on day one).
   */
  poll(previousCursor: TCursor | undefined): Promise<{ newItems: TItem[]; nextCursor: TCursor }>;
  /** Formats one item as a single plain, factual line — no editorializing (that's the model's job once it sees the note, not this function's). */
  describe(item: TItem): string;
}
