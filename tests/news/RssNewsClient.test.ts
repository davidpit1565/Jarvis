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

  test("never returns more than the hard cap, even if a caller passes an unreasonably large maxItems", async () => {
    const items = Array.from(
      { length: 30 },
      (_, i) => `<item><title>Headline ${i}</title><link>https://example.com/${i}</link></item>`
    ).join("\n");
    global.fetch = (async () =>
      new Response(`<rss><channel>${items}</channel></rss>`, { status: 200 })) as unknown as typeof fetch;

    const client = new RssNewsClient("https://example.com/feed.xml");
    const headlines = await client.getTopHeadlines(999);

    expect(headlines.length).toBeLessThanOrEqual(20);
  });

  test("returns an empty array for a feed with no items", async () => {
    global.fetch = (async () =>
      new Response("<rss><channel></channel></rss>", { status: 200 })) as unknown as typeof fetch;

    const client = new RssNewsClient("https://example.com/feed.xml");
    const headlines = await client.getTopHeadlines();

    expect(headlines).toEqual([]);
  });

  test("throws on a non-2xx, non-retryable response", async () => {
    global.fetch = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;

    const client = new RssNewsClient("https://example.com/feed.xml");
    await expect(client.getTopHeadlines()).rejects.toThrow(/404/);
  });

  test("dedups headlines by link across repeated entries in the same feed", async () => {
    global.fetch = (async () =>
      new Response(
        `<rss><channel>
          <item><title>Big story</title><link>https://example.com/story</link></item>
          <item><title>Big story (updated)</title><link>https://example.com/story</link></item>
          <item><title>Other story</title><link>https://example.com/other</link></item>
        </channel></rss>`,
        { status: 200 }
      )) as unknown as typeof fetch;

    const client = new RssNewsClient("https://example.com/feed.xml");
    const headlines = await client.getTopHeadlines(10);

    expect(headlines).toEqual([
      { title: "Big story", link: "https://example.com/story" },
      { title: "Other story", link: "https://example.com/other" },
    ]);
  });

  test("dedups headlines by title across repeated entries with different links", async () => {
    global.fetch = (async () =>
      new Response(
        `<rss><channel>
          <item><title>Same headline</title><link>https://example.com/a</link></item>
          <item><title>Same headline</title><link>https://example.com/b-syndicated</link></item>
        </channel></rss>`,
        { status: 200 }
      )) as unknown as typeof fetch;

    const client = new RssNewsClient("https://example.com/feed.xml");
    const headlines = await client.getTopHeadlines(10);

    expect(headlines).toEqual([{ title: "Same headline", link: "https://example.com/a" }]);
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

  test("never returns more than the hard cap, even if a caller passes an unreasonably large maxItems", async () => {
    const items = Array.from(
      { length: 30 },
      (_, i) => `<item><title>Matching headline ${i}</title><link>https://example.com/${i}</link></item>`
    ).join("\n");
    global.fetch = (async () =>
      new Response(`<rss><channel>${items}</channel></rss>`, { status: 200 })) as unknown as typeof fetch;

    const client = new RssNewsClient("https://example.com/feed.xml");
    const headlines = await client.searchHeadlines("matching", 999);

    expect(headlines.length).toBeLessThanOrEqual(20);
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
      // A 404 is not retryable (unlike 429/5xx — see the retry test
      // below), so this exercises "no caching on failure" without also
      // depending on the retry helper's exact attempt count.
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const client = new RssNewsClient("https://example.com/feed.xml");
    await expect(client.getTopHeadlines()).rejects.toThrow();
    await expect(client.getTopHeadlines()).rejects.toThrow();

    expect(fetchCalls).toBe(2);
  });

  test("retries a transient 5xx and succeeds once the feed recovers, without failing the call", async () => {
    let fetchCalls = 0;
    global.fetch = (async () => {
      fetchCalls++;
      if (fetchCalls < 2) return new Response("boom", { status: 503 });
      return new Response(SAMPLE_FEED, { status: 200 });
    }) as unknown as typeof fetch;

    const client = new RssNewsClient("https://example.com/feed.xml");
    const headlines = await client.getTopHeadlines();

    expect(headlines.length).toBeGreaterThan(0);
    expect(fetchCalls).toBe(2);
  });

  test("gives up and throws after repeated 5xx failures", async () => {
    let fetchCalls = 0;
    global.fetch = (async () => {
      fetchCalls++;
      return new Response("boom", { status: 500 });
    }) as unknown as typeof fetch;

    const client = new RssNewsClient("https://example.com/feed.xml");
    await expect(client.getTopHeadlines()).rejects.toThrow(/500/);
    expect(fetchCalls).toBe(3);
  });
});
