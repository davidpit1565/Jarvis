import { describe, test, expect, afterEach } from "bun:test";
import { RssNewsClient } from "@/news/RssNewsClient";
import { createGetNewsTool } from "@/tools/news/GetNewsTool";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

describe("GET_NEWS tool", () => {
  test("is READ", () => {
    const tool = createGetNewsTool(new RssNewsClient("https://example.com/feed.xml"));
    expect(tool.requiredPermission).toBe(PermissionLevel.READ);
  });

  test("rejects an invalid maxItems", async () => {
    const tool = createGetNewsTool(new RssNewsClient("https://example.com/feed.xml"));
    const result = await tool.execute({ maxItems: -1 }, context);
    expect(result.success).toBe(false);
  });

  test("returns headlines on success", async () => {
    global.fetch = (async () =>
      new Response(
        "<rss><channel><item><title>Hi</title><link>https://example.com/1</link></item></channel></rss>",
        { status: 200 }
      )) as unknown as typeof fetch;

    const tool = createGetNewsTool(new RssNewsClient("https://example.com/feed.xml"));
    const result = await tool.execute({}, context);

    expect(result.success).toBe(true);
    expect((result.data as { headlines: unknown[] }).headlines).toHaveLength(1);
  });

  test("returns a failure result (not a throw) when the feed request fails", async () => {
    global.fetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;

    const tool = createGetNewsTool(new RssNewsClient("https://example.com/feed.xml"));
    const result = await tool.execute({}, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain("500");
  });
});
