import { fetchWithRetry } from "@/core/net/fetchWithRetry";

export interface NewsHeadline {
  title: string;
  link: string;
}

// Matches one RSS <item>...</item> block (case-insensitive, spans newlines).
const ITEM_PATTERN = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
const TITLE_PATTERN = /<title\b[^>]*>([\s\S]*?)<\/title>/i;
const LINK_PATTERN = /<link\b[^>]*>([\s\S]*?)<\/link>/i;

function decodeXmlText(raw: string): string {
  const withoutCdata = raw.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1");
  return withoutCdata
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

// An RSS feed doesn't publish new items every second, so a short cache
// avoids re-fetching and re-parsing the whole feed for every get_news/
// search_news call in quick succession — real latency/load savings, same
// reasoning as OpenMeteoClient's current-weather cache.
const ITEMS_CACHE_TTL_MS = 5 * 60_000;

// Same "cap unbounded results" reasoning as GoogleCalendarClient/
// GmailClient/SpotifyClient: the tools validate maxItems is a positive
// integer but never bounded how large it can be, so a caller passing an
// unreasonably large value would stuff every parsed headline from the
// feed into the tool result and conversation history.
const MAX_HEADLINES_CAP = 20;

/**
 * Free news headlines from any RSS feed the user configures — no API key,
 * no account, matching this project's "as close to free as possible"
 * goal. Deliberately a small regex-based RSS reader rather than a full
 * XML parser dependency: real-world RSS is messy, but every item this
 * project cares about (title + link) follows the same simple shape, and
 * a malformed/unexpected feed just yields fewer/no items rather than
 * throwing.
 */
export class RssNewsClient {
  private cachedItems: { value: NewsHeadline[]; fetchedAt: number } | undefined;

  constructor(private readonly feedUrl: string) {}

  private async fetchAllItems(): Promise<NewsHeadline[]> {
    if (this.cachedItems && Date.now() - this.cachedItems.fetchedAt < ITEMS_CACHE_TTL_MS) {
      return this.cachedItems.value;
    }

    // Bounded fetch (timeout + retry-with-backoff on 429/5xx or a
    // network-level failure), same reasoning/helper as GmailClient and
    // TelegramGateway — an RSS host can be just as flaky as any other
    // external API, and a stuck request here would otherwise hang the
    // whole GET_NEWS/SEARCH_NEWS tool call.
    const response = await fetchWithRetry(this.feedUrl, {}, { baseDelayMs: 50 });
    if (!response.ok) {
      throw new Error(`RSS feed request failed (${response.status}): ${await response.text().catch(() => "")}`);
    }

    const xml = await response.text();
    const headlines: NewsHeadline[] = [];
    // A feed can legitimately (or by publisher error) list the same story
    // twice — e.g. an updated item re-published with the same link, or two
    // <item> blocks that only differ by tracking params already stripped
    // by decodeXmlText. Dedup by link first (the stronger identity), then
    // by title for the rare case of the same story at two different
    // links (a canonical URL and a syndicated redirect).
    const seenLinks = new Set<string>();
    const seenTitles = new Set<string>();

    for (const match of xml.matchAll(ITEM_PATTERN)) {
      const itemXml = match[1] ?? "";
      const titleMatch = itemXml.match(TITLE_PATTERN);
      const linkMatch = itemXml.match(LINK_PATTERN);
      if (!titleMatch || !linkMatch) continue;

      const title = decodeXmlText(titleMatch[1] ?? "");
      const link = decodeXmlText(linkMatch[1] ?? "");
      if (!title || !link) continue;

      const linkKey = link.toLowerCase();
      const titleKey = title.trim().toLowerCase();
      if (seenLinks.has(linkKey) || seenTitles.has(titleKey)) continue;

      seenLinks.add(linkKey);
      seenTitles.add(titleKey);
      headlines.push({ title, link });
    }

    this.cachedItems = { value: headlines, fetchedAt: Date.now() };
    return headlines;
  }

  async getTopHeadlines(maxItems: number = 5): Promise<NewsHeadline[]> {
    const headlines = await this.fetchAllItems();
    return headlines.slice(0, Math.min(maxItems, MAX_HEADLINES_CAP));
  }

  /** Headlines whose title contains `query` (case-insensitive), most-recent-first order preserved from the feed. */
  async searchHeadlines(query: string, maxItems: number = 5): Promise<NewsHeadline[]> {
    const headlines = await this.fetchAllItems();
    const needle = query.toLowerCase();
    return headlines.filter((h) => h.title.toLowerCase().includes(needle)).slice(0, Math.min(maxItems, MAX_HEADLINES_CAP));
  }
}
