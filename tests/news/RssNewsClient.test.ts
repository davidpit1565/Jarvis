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

describe("RssNewsClient.searchHeadlines", () => {
  test("filters headlines whose title matches the query, case-insensitively", async () => {
    global.fetch = (async () => new Response(SAMPLE_FEED, { status: 200 })) as unknown as typeof fetch;

    const client = new RssNewsClient("https://example.com/feed.xml");
    const headlines = await client.searchHeadlines("SECOND");

    expect(headlines).toEqual([{ title: "Second headline", link: "https://example.com/2" }]);
  });

  test("returns an empty array when nothing matches", async () => {
    global.fetch = (async () => new Response(SAMPLE_FEED, { status: 200 })) as unknown as typeof fetch;

    const client = new RssNewsClient("https://example.com/feed.xml");
    const headlines = await client.searchHeadlines("nonexistent-topic");

    expect(headlines).toEqual([]);
  });

  test("caps results at maxItems", async () => {
    global.fetch = (async () => new Response(SAMPLE_FEED, { status: 200 })) as unknown as typeof fetch;

    const client = new RssNewsClient("https://example.com/feed.xml");
    const headlines = await client.searchHeadlines("headline", 1);

    expect(headlines).toHaveLength(1);
  });

  test("throws on a non-2xx response", async () => {
    global.fetch = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;

    const client = new RssNewsClient("https://example.com/feed.xml");
    await expect(client.searchHeadlines("headline")).rejects.toThrow(/404/);
  });
});

describe("RssNewsClient item caching", () => {
  test("a second call within the TTL doesn't re-fetch, even for a different method", async () => {
    let fetchCalls = 0;
    global.fetch = (async () => {
      fetchCalls++;
      return new Response(SAMPLE_FEED, { status: 200 });
    }) as unknown as typeof fetch;

    const client = new RssNewsClient("https://example.com/feed.xml");
    await client.getTopHeadlines();
    await client.searchHeadlines("second");

    expect(fetchCalls).toBe(1);
  });

  test("does not cache a failed request", async () => {
    let fetchCalls = 0;
    global.fetch = (async () => {
      fetchCalls++;
      return new Response("boom", { status: 500 });
    }) as unknown as typeof fetch;

    const client = new RssNewsClient("https://example.com/feed.xml");
    await expect(client.getTopHeadlines()).rejects.toThrow();
    await expect(client.getTopHeadlines()).rejects.toThrow();

    expect(fetchCalls).toBe(2);
  });
});
