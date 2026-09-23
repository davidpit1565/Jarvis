import { describe, test, expect, afterEach } from "bun:test";
import { StudioClient } from "@/studio/StudioClient";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function makeClient(): StudioClient {
  return new StudioClient("https://studio.example.com", "secret-1");
}

describe("StudioClient.listReels", () => {
  test("returns the reels list and sends the bearer secret", async () => {
    let capturedAuth = "";
    global.fetch = (async (url: string | URL, init?: RequestInit) => {
      capturedAuth = (init?.headers as Record<string, string>)?.Authorization ?? "";
      expect(url.toString()).toBe("https://studio.example.com/api/jarvis/reels");
      return new Response(JSON.stringify({ ok: true, reels: [{ file: "ep1.mp4" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const reels = await makeClient().listReels();
    expect(reels).toEqual([{ file: "ep1.mp4" }] as never);
    expect(capturedAuth).toBe("Bearer secret-1");
  });

  test("throws on a non-2xx response", async () => {
    global.fetch = (async () => new Response("locked", { status: 401 })) as unknown as typeof fetch;
    await expect(makeClient().listReels()).rejects.toThrow(/401/);
  });

  test("does not leak the raw response body into the thrown error", async () => {
    global.fetch = (async () => new Response("internal upstream detail", { status: 500 })) as unknown as typeof fetch;
    let error: Error | undefined;
    await makeClient().listReels().catch((e) => {
      error = e as Error;
    });
    expect(error?.message).not.toContain("internal upstream detail");
    expect(error?.message).toContain("500");
  });

  test("throws when the studio reports ok: false", async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ ok: false, reason: "no reels dir" }), { status: 200 })) as unknown as typeof fetch;
    await expect(makeClient().listReels()).rejects.toThrow(/no reels dir/);
  });
});

describe("StudioClient.getInstagramStats", () => {
  test("returns the stats payload reshaped to the declared fields", async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ connected: true, username: "actuallyworks", followers: 100, mediaCount: 5, media: [] }), {
        status: 200,
      })) as unknown as typeof fetch;

    const stats = await makeClient().getInstagramStats();
    expect(stats).toEqual({ connected: true, username: "actuallyworks", followers: 100, mediaCount: 5, media: [] });
  });

  test("returns connected: false as-is, without trying to reshape media", async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ connected: false, reason: "not linked" }), { status: 200 })) as unknown as typeof fetch;

    const stats = await makeClient().getInstagramStats();
    expect(stats).toEqual({ connected: false, reason: "not linked" });
  });

  test("strips undeclared debug/status fields the studio's real API includes per post", async () => {
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          connected: true,
          username: "actuallyworks",
          followers: 100,
          mediaCount: 1,
          media: [
            {
              id: "1",
              caption: "hi",
              permalink: "https://instagram.com/p/1",
              timestamp: "2026-01-01T00:00:00Z",
              mediaType: "VIDEO",
              views: 10,
              reach: 8,
              saves: 1,
              shares: 0,
              likes: 2,
              comments: 0,
              metricStatus: { views: "AVAILABLE" },
              reachByFollowerTypeStatus: "NOT_AVAILABLE",
              reachByFollowerTypeDebug: '{"error":{"message":"boom"}}',
              watchAvgSeconds: null,
              watchTotalSeconds: null,
              watchReplays: null,
              watchPlays: null,
              watchStatus: "NOT_AVAILABLE",
            },
          ],
        }),
        { status: 200 }
      )) as unknown as typeof fetch;

    const stats = await makeClient().getInstagramStats();
    expect(stats).toEqual({
      connected: true,
      username: "actuallyworks",
      followers: 100,
      mediaCount: 1,
      media: [
        {
          id: "1",
          caption: "hi",
          permalink: "https://instagram.com/p/1",
          timestamp: "2026-01-01T00:00:00Z",
          mediaType: "VIDEO",
          views: 10,
          reach: 8,
          saves: 1,
          shares: 0,
          likes: 2,
          comments: 0,
        },
      ],
    });
  });

  test("caps the media list to the 10 most recent posts", async () => {
    const media = Array.from({ length: 25 }, (_, i) => ({
      id: `${i}`,
      caption: `post ${i}`,
      permalink: null,
      timestamp: null,
      mediaType: null,
      views: null,
      reach: null,
      saves: null,
      shares: null,
      likes: null,
      comments: null,
    }));
    global.fetch = (async () =>
      new Response(JSON.stringify({ connected: true, username: "u", followers: 1, mediaCount: 25, media }), {
        status: 200,
      })) as unknown as typeof fetch;

    const stats = await makeClient().getInstagramStats();
    if (!stats.connected) throw new Error("expected connected: true");
    expect(stats.media).toHaveLength(10);
    expect(stats.media[0]?.id).toBe("0");
  });

  test("truncates long captions instead of passing full hashtag-laden text through", async () => {
    const longCaption = "a".repeat(500);
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          connected: true,
          username: "u",
          followers: 1,
          mediaCount: 1,
          media: [
            {
              id: "1",
              caption: longCaption,
              permalink: null,
              timestamp: null,
              mediaType: null,
              views: null,
              reach: null,
              saves: null,
              shares: null,
              likes: null,
              comments: null,
            },
          ],
        }),
        { status: 200 }
      )) as unknown as typeof fetch;

    const stats = await makeClient().getInstagramStats();
    if (!stats.connected) throw new Error("expected connected: true");
    expect(stats.media[0]?.caption.length).toBeLessThan(longCaption.length);
    expect(stats.media[0]?.caption.endsWith("…")).toBe(true);
  });

  test("throws on a non-2xx response", async () => {
    global.fetch = (async () => new Response("locked", { status: 401 })) as unknown as typeof fetch;
    await expect(makeClient().getInstagramStats()).rejects.toThrow(/401/);
  });

  test("does not leak the raw response body into the thrown error", async () => {
    global.fetch = (async () => new Response("internal upstream detail", { status: 500 })) as unknown as typeof fetch;
    let error: Error | undefined;
    await makeClient().getInstagramStats().catch((e) => {
      error = e as Error;
    });
    expect(error?.message).not.toContain("internal upstream detail");
    expect(error?.message).toContain("500");
  });
});

describe("StudioClient.publish", () => {
  test("sends the file and caption as a POST body", async () => {
    let capturedBody: unknown;
    let capturedMethod: string | undefined;
    global.fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body;
      capturedMethod = init?.method;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await makeClient().publish("ep1.mp4", "caption text");
    expect(capturedMethod).toBe("POST");
    expect(JSON.parse(capturedBody as string)).toEqual({ file: "ep1.mp4", caption: "caption text" });
    expect(result).toEqual({ ok: true });
  });

  test("returns a synthesized failure result if the response body isn't JSON", async () => {
    global.fetch = (async () => new Response("internal error", { status: 500 })) as unknown as typeof fetch;
    const result = await makeClient().publish("ep1.mp4", "caption");
    expect(result.ok).toBe(false);
  });

  test("omits the caption field entirely when not provided, instead of sending an empty string that would override the studio's own caption", async () => {
    let capturedBody: unknown;
    global.fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    await makeClient().publish("ep1.mp4");
    expect(JSON.parse(capturedBody as string)).toEqual({ file: "ep1.mp4" });
  });
});
