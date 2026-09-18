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

  test("throws when the studio reports ok: false", async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ ok: false, reason: "no reels dir" }), { status: 200 })) as unknown as typeof fetch;
    await expect(makeClient().listReels()).rejects.toThrow(/no reels dir/);
  });
});

describe("StudioClient.getInstagramStats", () => {
  test("returns the stats payload as-is", async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ connected: true, username: "actuallyworks", followers: 100, mediaCount: 5, media: [] }), {
        status: 200,
      })) as unknown as typeof fetch;

    const stats = await makeClient().getInstagramStats();
    expect(stats).toEqual({ connected: true, username: "actuallyworks", followers: 100, mediaCount: 5, media: [] });
  });

  test("throws on a non-2xx response", async () => {
    global.fetch = (async () => new Response("locked", { status: 401 })) as unknown as typeof fetch;
    await expect(makeClient().getInstagramStats()).rejects.toThrow(/401/);
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
});
