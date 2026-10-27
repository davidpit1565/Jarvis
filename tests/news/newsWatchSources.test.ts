import { describe, test, expect } from "bun:test";
import { createNewsWatchSources, newsSourceId } from "@/news/newsWatchSources";
import type { RssNewsClient, NewsHeadline } from "@/news/RssNewsClient";

function headline(title: string, link: string): NewsHeadline {
  return { title, link };
}

function stubNewsClient(byQuery: Record<string, NewsHeadline[]>): RssNewsClient {
  return {
    searchHeadlines: async (query: string) => byQuery[query] ?? [],
  } as unknown as RssNewsClient;
}

describe("newsSourceId", () => {
  test("is stable and case/whitespace-insensitive", () => {
    expect(newsSourceId("AI Safety")).toBe(newsSourceId(" ai safety ".trim()));
    expect(newsSourceId("AI Safety")).toBe("news:ai safety");
  });
});

describe("createNewsWatchSources", () => {
  test("builds one source per configured topic", () => {
    const client = stubNewsClient({});
    const sources = createNewsWatchSources(client, ["ai safety", "rust"]);
    expect(sources.map((s) => s.id)).toEqual(["news:ai safety", "news:rust"]);
  });

  test("a first-ever poll establishes a baseline cursor and reports nothing as new", async () => {
    const client = stubNewsClient({ topic: [headline("Story 1", "https://x/1"), headline("Story 2", "https://x/2")] });
    const [source] = createNewsWatchSources(client, ["topic"]);

    const { newItems, nextCursor } = await source!.poll(undefined);

    expect(newItems).toEqual([]);
    expect(nextCursor.seenLinks).toEqual(["https://x/1", "https://x/2"]);
  });

  test("a second poll reports only headlines not seen in the previous cursor", async () => {
    const client = stubNewsClient({ topic: [headline("Story 3", "https://x/3"), headline("Story 1", "https://x/1"), headline("Story 2", "https://x/2")] });
    const [source] = createNewsWatchSources(client, ["topic"]);

    const { newItems } = await source!.poll({ seenLinks: ["https://x/1", "https://x/2"] });

    expect(newItems).toEqual([headline("Story 3", "https://x/3")]);
  });

  test("re-polling with the same headlines reports nothing new, no double-counting", async () => {
    const client = stubNewsClient({ topic: [headline("Story 1", "https://x/1")] });
    const [source] = createNewsWatchSources(client, ["topic"]);

    const first = await source!.poll(undefined);
    const second = await source!.poll(first.nextCursor);
    const third = await source!.poll(second.nextCursor);

    expect(second.newItems).toEqual([]);
    expect(third.newItems).toEqual([]);
  });

  test("link matching is case-insensitive", async () => {
    const client = stubNewsClient({ topic: [headline("Story 1", "HTTPS://X/1")] });
    const [source] = createNewsWatchSources(client, ["topic"]);

    const { newItems } = await source!.poll({ seenLinks: ["https://x/1"] });
    expect(newItems).toEqual([]);
  });

  test("describe() formats a headline as a plain quoted title", () => {
    const client = stubNewsClient({});
    const [source] = createNewsWatchSources(client, ["topic"]);
    expect(source!.describe(headline("My Story", "https://x/1"))).toBe('"My Story"');
  });
});
