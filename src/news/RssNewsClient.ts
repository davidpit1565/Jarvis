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
  constructor(private readonly feedUrl: string) {}

  async getTopHeadlines(maxItems: number = 5): Promise<NewsHeadline[]> {
    const response = await fetch(this.feedUrl);
    if (!response.ok) {
      throw new Error(`RSS feed request failed (${response.status}): ${await response.text().catch(() => "")}`);
    }

    const xml = await response.text();
    const headlines: NewsHeadline[] = [];

    for (const match of xml.matchAll(ITEM_PATTERN)) {
      if (headlines.length >= maxItems) break;

      const itemXml = match[1] ?? "";
      const titleMatch = itemXml.match(TITLE_PATTERN);
      const linkMatch = itemXml.match(LINK_PATTERN);
      if (!titleMatch || !linkMatch) continue;

      const title = decodeXmlText(titleMatch[1] ?? "");
      const link = decodeXmlText(linkMatch[1] ?? "");
      if (title && link) headlines.push({ title, link });
    }

    return headlines;
  }
}
