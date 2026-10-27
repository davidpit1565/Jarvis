import type { WatchSource } from "@/watcher/WatchSource";
import type { GmailClient } from "@/gmail/GmailClient";
import type { EmailSummary } from "@/types/gmail";

/** How many messages a single query poll asks Gmail for — `GmailClient.searchMessages` already caps this at its own MAX_RESULTS_CAP (10), this is just this source's own request size. */
const GMAIL_WATCH_MAX_RESULTS = 10;

/** How many previously-seen message ids a query's cursor remembers — bounded so the cursor itself (and the SQLite row holding it) never grows unboundedly, the same reasoning as news's `SEEN_LINKS_CURSOR_CAP`. A query's live result set is already capped at `GMAIL_WATCH_MAX_RESULTS`, so this just needs to comfortably exceed that. */
const SEEN_IDS_CURSOR_CAP = 40;

/** How much of a surfaced email's preview (subject + sender + snippet) a watcher note/push is allowed to show — deliberately short and NEVER the full body (see `GmailClient.getMessageBody`'s own MAX_BODY_LENGTH for the "full body" case this is explicitly not). Per CLAUDE.md: avoid leaking large amounts of email content into a note that can surface in an unrelated later conversation. */
const MAX_PREVIEW_LENGTH = 160;

export interface GmailCursor {
  /** Message ids seen as of the previous poll — used purely to tell "new message" apart from "already seen," never replayed. */
  seenIds: string[];
}

const SOURCE_PREFIX = "gmail:";

export function gmailSourceId(query: string): string {
  return `${SOURCE_PREFIX}${query.trim().toLowerCase()}`;
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/**
 * Builds one `WatchSource` per David-configured Gmail search query
 * (`GMAIL_WATCH_QUERIES`, matching the existing `GITHUB_WATCHED_REPOS`/
 * `NEWS_WATCH_TOPICS` explicit opt-in pattern — see `src/config/index.ts`),
 * each query polling the existing `GmailClient.searchMessages` (raw Gmail
 * search syntax, e.g. "from:someone@example.com" or "subject:invoice" —
 * confirmed `searchMessages` already accepts this as its `query` argument
 * verbatim, no new Gmail API code needed) and reporting whichever message
 * ids weren't present in the previous poll's result set.
 *
 * "New" is defined by cursor-remembered message ids rather than a date
 * cutoff, the same shape of reasoning `newsWatchSources`'s link-based
 * cursor gives for its own feed: a query's live result set is already
 * capped (`GMAIL_WATCH_MAX_RESULTS`) and `searchMessages` itself returns
 * newest-first, so "wasn't in the last poll's id set" is a simple, honest
 * definition of new that needs no separate date parsing. Like GitHub's
 * commit/issue diffing and news's own first-poll behavior, a query's
 * first-ever poll only establishes a baseline and reports nothing as new —
 * reporting a mailbox's entire current matches as "new" on day one would be
 * exactly the fabricated-looking activity this whole feature must avoid.
 *
 * Deliberately does NOT call `GmailClient.getMessageBody` — each watch
 * source only ever surfaces the sender/subject/snippet `searchMessages`
 * already returns, capped by `MAX_PREVIEW_LENGTH`, never a message's full
 * body (see that constant's own doc comment).
 */
export function createGmailWatchSources(gmailClient: GmailClient, queries: string[]): Array<WatchSource<GmailCursor, EmailSummary>> {
  return queries.map((query) => ({
    id: gmailSourceId(query),
    label: `gmail — "${query}"`,

    async poll(previousCursor) {
      const messages = await gmailClient.searchMessages(query, GMAIL_WATCH_MAX_RESULTS);
      const seenIds = new Set(previousCursor?.seenIds ?? []);
      const isFirstPoll = previousCursor === undefined;

      const newItems = isFirstPoll ? [] : messages.filter((message) => !seenIds.has(message.id));

      const nextCursor: GmailCursor = {
        seenIds: messages.map((message) => message.id).slice(0, SEEN_IDS_CURSOR_CAP),
      };

      return { newItems, nextCursor };
    },

    describe(item) {
      const from = truncate(item.from || "(unknown sender)", MAX_PREVIEW_LENGTH);
      const subject = truncate(item.subject || "(no subject)", MAX_PREVIEW_LENGTH);
      const preview = item.snippet ? ` — "${truncate(item.snippet, MAX_PREVIEW_LENGTH)}"` : "";
      return `from ${from}, "${subject}"${preview}`;
    },
  }));
}
