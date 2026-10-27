import type { WatchSource } from "@/watcher/WatchSource";
import type { RssNewsClient, NewsHeadline } from "@/news/RssNewsClient";

/** How many headlines a single topic poll asks the feed for — the feed itself is already capped (see RssNewsClient.MAX_HEADLINES_CAP), this is just this source's own request size. */
const NEWS_POLL_MAX_HEADLINES = 20;

/** How many previously-seen links a topic's cursor remembers — bounded so the cursor itself (and the SQLite row holding it) never grows unboundedly; the feed itself only ever has a capped number of current items, so this just needs to comfortably exceed that. */
const SEEN_LINKS_CURSOR_CAP = 40;

export interface NewsCursor {
  /** Lowercased links seen as of the previous poll, most-recent-first — used purely to tell "new headline" apart from "already seen," never replayed. */
  seenLinks: string[];
}

const SOURCE_PREFIX = "news:";

export function newsSourceId(topic: string): string {
  return `${SOURCE_PREFIX}${topic.trim().toLowerCase()}`;
}

/**
 * Builds one `WatchSource` per David-configured topic/keyword
 * (`NEWS_WATCH_TOPICS`, matching the existing GitHub pattern's explicit
 * `GITHUB_WATCHED_REPOS`-style opt-in — see `src/config/index.ts`), each
 * checking the same shared `RssNewsClient` feed on every poll and
 * filtering for headlines whose title contains that topic and that
 * weren't present on the previous poll.
 *
 * "New" is defined by cursor-remembered links rather than a publish-date
 * cutoff: this project's minimal regex-based `RssNewsClient` (see its own
 * doc comment) doesn't reliably parse `<pubDate>`, and a feed's set of
 * current items is already capped (`RssNewsClient.MAX_HEADLINES_CAP`), so
 * "wasn't in the last poll's snapshot" is a simple, honest definition of
 * new that needs no additional parsing. Like GitHub's commit/issue
 * diffing, a source's first-ever poll only establishes a baseline and
 * reports nothing as new — reporting a feed's entire current contents as
 * "new" on day one would be exactly the fabricated-looking activity this
 * whole feature must avoid.
 */
export function createNewsWatchSources(newsClient: RssNewsClient, topics: string[]): Array<WatchSource<NewsCursor, NewsHeadline>> {
  return topics.map((topic) => ({
    id: newsSourceId(topic),
    label: `news — "${topic}"`,

    async poll(previousCursor) {
      const headlines = await newsClient.searchHeadlines(topic, NEWS_POLL_MAX_HEADLINES);
      const seenLinks = new Set(previousCursor?.seenLinks ?? []);
      const isFirstPoll = previousCursor === undefined;

      const newItems = isFirstPoll ? [] : headlines.filter((headline) => !seenLinks.has(headline.link.toLowerCase()));

      const nextCursor: NewsCursor = {
        seenLinks: headlines.map((headline) => headline.link.toLowerCase()).slice(0, SEEN_LINKS_CURSOR_CAP),
      };

      return { newItems, nextCursor };
    },

    describe(item) {
      return `"${item.title}"`;
    },
  }));
}
