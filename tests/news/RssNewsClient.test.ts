import { describe, test, expect, afterEach } from "bun:test";
import { RssNewsClient } from "@/news/RssNewsClient";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

const SAMPLE_FEED = `<?xml version="1.0"?>
<rss><channel>
  <item><title><![CDATA[First &amp; headline]]></title><link>https://example.com/1</link></item>
  <item><title>Second headline</title><link>https://example.com/2</link></item>
  <item><title>Third headline</title><link>https://example.com/3</link></item>
</channel></rss>`;

describe("RssNewsClient.getTopHeadlines", () => {
  test("parses title/link pairs from a real-shaped RSS feed", async () => {
    global.fetch = (async () => new Response(SAMPLE_FEED, { status: 200 })) as unknown as typeof fetch;

    const client = new RssNewsClient("https://example.com/feed.xml");
    const headlines = await client.getTopHeadlines();

    expect(headlines).toEqual([
      { title: "First & headline", link: "https://example.com/1" },
      { title: "Second headline", link: "https://example.com/2" },
      { title: "Third headline", link: "https://example.com/3" },
    ]);
  });

  test("caps results at maxItems", async () => {
    global.fetch = (async () => new Response(SAMPLE_FEED, { status: 200 })) as unknown as typeof fetch;

    const client = new RssNewsClient("https://example.com/feed.xml");
    const headlines = await client.getTopHeadlines(2);

    expect(headlines).toHaveLength(2);
  });

  test("returns an empty array for a feed with no items", async () => {
    global.fetch = (async () =>
      new Response("<rss><channel></channel></rss>", { status: 200 })) as unknown as typeof fetch;

    const client = new RssNewsClient("https://example.com/feed.xml");
    const headlines = await client.getTopHeadlines();

    expect(headlines).toEqual([]);
  });

  test("throws on a non-2xx response", async () => {
    global.fetch = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;

    const client = new RssNewsClient("https://example.com/feed.xml");
    await expect(client.getTopHeadlines()).rejects.toThrow(/404/);
  });
});
