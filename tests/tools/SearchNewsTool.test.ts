import { describe, test, expect, afterEach } from "bun:test";
import { RssNewsClient } from "@/news/RssNewsClient";
import { createSearchNewsTool } from "@/tools/news/SearchNewsTool";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

describe("SEARCH_NEWS tool", () => {
  test("is READ", () => {
    const tool = createSearchNewsTool(new RssNewsClient("https://example.com/feed.xml"));
    expect(tool.requiredPermission).toBe(PermissionLevel.READ);
  });

  test("opts into the Semantic Result Cache (a loosely-phrased query over one time-bounded feed)", () => {
    const tool = createSearchNewsTool(new RssNewsClient("https://example.com/feed.xml"));
    expect(tool.semanticCacheable).toBe(true);
  });

  test("rejects a missing/empty query", async () => {
    const tool = createSearchNewsTool(new RssNewsClient("https://example.com/feed.xml"));
    expect((await tool.execute({} as never, context)).success).toBe(false);
    expect((await tool.execute({ query: "  " }, context)).success).toBe(false);
  });

  test("rejects an invalid maxItems", async () => {
    const tool = createSearchNewsTool(new RssNewsClient("https://example.com/feed.xml"));
    const result = await tool.execute({ query: "x", maxItems: -1 }, context);
    expect(result.success).toBe(false);
  });

  test("returns matching headlines on success", async () => {
    global.fetch = (async () =>
      new Response(
        "<rss><channel>" +
          "<item><title>Election results</title><link>https://example.com/1</link></item>" +
          "<item><title>Weather update</title><link>https://example.com/2</link></item>" +
          "</channel></rss>",
        { status: 200 }
      )) as unknown as typeof fetch;

    const tool = createSearchNewsTool(new RssNewsClient("https://example.com/feed.xml"));
    const result = await tool.execute({ query: "election" }, context);

    expect(result.success).toBe(true);
    expect((result.data as { headlines: unknown[] }).headlines).toHaveLength(1);
  });

  test("returns a failure result (not a throw) when the feed request fails", async () => {
    global.fetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;

    const tool = createSearchNewsTool(new RssNewsClient("https://example.com/feed.xml"));
    const result = await tool.execute({ query: "x" }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain("500");
  });
});
