import { describe, test, expect, afterEach } from "bun:test";
import { CalendarTokenStore } from "@/calendar/CalendarTokenStore";
import { YouTubeClient } from "@/youtube/YouTubeClient";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function makeClient(tokenStore = new CalendarTokenStore(":memory:")) {
  return { client: new YouTubeClient("client-id", "client-secret", tokenStore), tokenStore };
}

function makeLinkedTokenStore(email = "me@example.com"): CalendarTokenStore {
  const tokenStore = new CalendarTokenStore(":memory:");
  tokenStore.save(email, { refreshToken: "r1", accessToken: "valid", accessTokenExpiresAt: Date.now() + 3_600_000 });
  return tokenStore;
}

describe("YouTubeClient.getMyChannel", () => {
  test("throws when no account is linked", async () => {
    const { client } = makeClient();
    await expect(client.getMyChannel()).rejects.toThrow(/no google account linked/i);
  });

  test("maps channel snippet/statistics, tagged with the account", async () => {
    global.fetch = (async (url: string) => {
      expect(url).toContain("/youtube/v3/channels");
      expect(url).toContain("mine=true");
      expect(url).toContain("part=snippet%2Cstatistics");
      return new Response(
        JSON.stringify({ items: [{ id: "UC123", snippet: { title: "Actually Works" }, statistics: { subscriberCount: "42", videoCount: "7" } }] }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    const channel = await client.getMyChannel();

    expect(channel).toEqual({
      id: "UC123",
      title: "Actually Works",
      subscriberCount: 42,
      videoCount: 7,
      account: "me@example.com",
    });
  });

  test("throws when the Google account has no YouTube channel", async () => {
    global.fetch = (async () => new Response(JSON.stringify({ items: [] }), { status: 200 })) as unknown as typeof fetch;
    const { client } = makeClient(makeLinkedTokenStore());
    await expect(client.getMyChannel()).rejects.toThrow(/no youtube channel/i);
  });

  test("throws on a non-2xx response", async () => {
    global.fetch = (async () => new Response("forbidden", { status: 403 })) as unknown as typeof fetch;
    const { client } = makeClient(makeLinkedTokenStore());
    await expect(client.getMyChannel()).rejects.toThrow(/403/);
  });
});

describe("YouTubeClient.listMyVideos", () => {
  test("resolves the uploads playlist id first, then lists its items", async () => {
    const calledUrls: string[] = [];
    global.fetch = (async (url: string) => {
      calledUrls.push(url);
      if (url.includes("/channels")) {
        return new Response(JSON.stringify({ items: [{ id: "UC123", contentDetails: { relatedPlaylists: { uploads: "UU123" } } }] }), { status: 200 });
      }
      expect(url).toContain("playlistId=UU123");
      return new Response(
        JSON.stringify({
          items: [
            { snippet: { title: "Video One", publishedAt: "2026-01-01T00:00:00Z", resourceId: { videoId: "v1" } } },
          ],
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    const videos = await client.listMyVideos();

    expect(calledUrls[0]).toContain("/channels");
    expect(calledUrls[1]).toContain("/playlistItems");
    expect(videos).toEqual([
      { id: "v1", title: "Video One", publishedAt: "2026-01-01T00:00:00Z", url: "https://www.youtube.com/watch?v=v1", account: "me@example.com" },
    ]);
  });

  test("throws when the channel has no uploads playlist", async () => {
    global.fetch = (async () => new Response(JSON.stringify({ items: [{ id: "UC123", contentDetails: {} }] }), { status: 200 })) as unknown as typeof fetch;
    const { client } = makeClient(makeLinkedTokenStore());
    await expect(client.listMyVideos()).rejects.toThrow(/uploads playlist/i);
  });
});

describe("YouTubeClient.getVideoStats", () => {
  test("maps video statistics/snippet, tagged with the account", async () => {
    global.fetch = (async (url: string) => {
      expect(url).toContain("/youtube/v3/videos");
      expect(url).toContain("id=v1");
      return new Response(
        JSON.stringify({ items: [{ id: "v1", snippet: { title: "Video One" }, statistics: { viewCount: "100", likeCount: "10", commentCount: "2" } }] }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    const stats = await client.getVideoStats("v1");

    expect(stats).toEqual({ id: "v1", title: "Video One", viewCount: 100, likeCount: 10, commentCount: 2, account: "me@example.com" });
  });

  test("throws when the video id doesn't exist", async () => {
    global.fetch = (async () => new Response(JSON.stringify({ items: [] }), { status: 200 })) as unknown as typeof fetch;
    const { client } = makeClient(makeLinkedTokenStore());
    await expect(client.getVideoStats("missing")).rejects.toThrow(/no youtube video found/i);
  });
});
