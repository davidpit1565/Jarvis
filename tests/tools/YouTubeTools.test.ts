import { describe, test, expect, afterEach } from "bun:test";
import { CalendarTokenStore } from "@/calendar/CalendarTokenStore";
import { YouTubeClient } from "@/youtube/YouTubeClient";
import { createGetMyYouTubeChannelTool } from "@/tools/youtube/GetMyYouTubeChannelTool";
import { createListMyYouTubeVideosTool } from "@/tools/youtube/ListMyYouTubeVideosTool";
import { createGetYouTubeVideoStatsTool } from "@/tools/youtube/GetYouTubeVideoStatsTool";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function makeYouTubeClient() {
  const tokenStore = new CalendarTokenStore(":memory:");
  tokenStore.save("me@example.com", { refreshToken: "r1", accessToken: "a1", accessTokenExpiresAt: Date.now() + 3_600_000 });
  return new YouTubeClient("id", "secret", tokenStore);
}

describe("GET_MY_YOUTUBE_CHANNEL tool", () => {
  test("is READ", () => {
    const tool = createGetMyYouTubeChannelTool(makeYouTubeClient());
    expect(tool.requiredPermission).toBe(PermissionLevel.READ);
  });

  test("returns channel info on success", async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ items: [{ id: "UC1", snippet: { title: "My Channel" }, statistics: { subscriberCount: "5", videoCount: "2" } }] }), { status: 200 })) as unknown as typeof fetch;

    const tool = createGetMyYouTubeChannelTool(makeYouTubeClient());
    const result = await tool.execute({}, context);

    expect(result.success).toBe(true);
    expect((result.data as { title: string }).title).toBe("My Channel");
  });

  test("returns a failure result (not a throw) on an API error", async () => {
    global.fetch = (async () => new Response("forbidden", { status: 403 })) as unknown as typeof fetch;
    const tool = createGetMyYouTubeChannelTool(makeYouTubeClient());
    const result = await tool.execute({}, context);
    expect(result.success).toBe(false);
  });
});

describe("LIST_MY_YOUTUBE_VIDEOS tool", () => {
  test("is READ", () => {
    const tool = createListMyYouTubeVideosTool(makeYouTubeClient());
    expect(tool.requiredPermission).toBe(PermissionLevel.READ);
  });

  test("rejects a non-positive maxResults", async () => {
    const tool = createListMyYouTubeVideosTool(makeYouTubeClient());
    const result = await tool.execute({ maxResults: 0 }, context);
    expect(result.success).toBe(false);
  });

  test("lists videos on success", async () => {
    global.fetch = (async (url: string) => {
      if (url.includes("/channels")) {
        return new Response(JSON.stringify({ items: [{ id: "UC1", contentDetails: { relatedPlaylists: { uploads: "UU1" } } }] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ items: [{ snippet: { title: "Vid", publishedAt: "2026-01-01T00:00:00Z", resourceId: { videoId: "v1" } } }] }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const tool = createListMyYouTubeVideosTool(makeYouTubeClient());
    const result = await tool.execute({}, context);

    expect(result.success).toBe(true);
    expect((result.data as { videos: unknown[] }).videos).toHaveLength(1);
  });

  test("returns a failure result (not a throw) on an API error", async () => {
    global.fetch = (async () => new Response("bad request", { status: 400 })) as unknown as typeof fetch;
    const tool = createListMyYouTubeVideosTool(makeYouTubeClient());
    const result = await tool.execute({}, context);
    expect(result.success).toBe(false);
  });
});

describe("GET_YOUTUBE_VIDEO_STATS tool", () => {
  test("is READ", () => {
    const tool = createGetYouTubeVideoStatsTool(makeYouTubeClient());
    expect(tool.requiredPermission).toBe(PermissionLevel.READ);
  });

  test("rejects a missing videoId", async () => {
    const tool = createGetYouTubeVideoStatsTool(makeYouTubeClient());
    const result = await tool.execute({ videoId: "" }, context);
    expect(result.success).toBe(false);
  });

  test("returns stats on success", async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ items: [{ id: "v1", snippet: { title: "Vid" }, statistics: { viewCount: "9", likeCount: "1", commentCount: "0" } }] }), { status: 200 })) as unknown as typeof fetch;

    const tool = createGetYouTubeVideoStatsTool(makeYouTubeClient());
    const result = await tool.execute({ videoId: "v1" }, context);

    expect(result.success).toBe(true);
    expect((result.data as { viewCount: number }).viewCount).toBe(9);
  });

  test("returns a failure result (not a throw) on an API error", async () => {
    global.fetch = (async () => new Response(JSON.stringify({ items: [] }), { status: 200 })) as unknown as typeof fetch;
    const tool = createGetYouTubeVideoStatsTool(makeYouTubeClient());
    const result = await tool.execute({ videoId: "missing" }, context);
    expect(result.success).toBe(false);
  });
});
