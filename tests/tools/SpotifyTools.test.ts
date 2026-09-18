import { describe, test, expect, afterEach } from "bun:test";
import { SpotifyTokenStore } from "@/spotify/SpotifyTokenStore";
import { SpotifyClient } from "@/spotify/SpotifyClient";
import { createGetCurrentlyPlayingTool } from "@/tools/spotify/GetCurrentlyPlayingTool";
import { createPlayMusicTool } from "@/tools/spotify/PlayMusicTool";
import { createPauseMusicTool } from "@/tools/spotify/PauseMusicTool";
import { createSkipTrackTool } from "@/tools/spotify/SkipTrackTool";
import { createUnlinkSpotifyTool } from "@/tools/spotify/UnlinkSpotifyTool";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function makeLinkedClient(): SpotifyClient {
  const tokenStore = new SpotifyTokenStore(":memory:");
  tokenStore.save({ refreshToken: "r1", accessToken: "a1", accessTokenExpiresAt: Date.now() + 3_600_000 });
  return new SpotifyClient("id", "secret", "https://example.com/callback", tokenStore);
}

describe("GET_CURRENTLY_PLAYING tool", () => {
  test("is READ", () => {
    const tool = createGetCurrentlyPlayingTool(makeLinkedClient());
    expect(tool.requiredPermission).toBe(PermissionLevel.READ);
  });

  test("returns the playback state", async () => {
    global.fetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const tool = createGetCurrentlyPlayingTool(makeLinkedClient());
    const result = await tool.execute({}, context);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ isPlaying: false, track: null, deviceName: null });
  });

  test("returns a failure result (not a throw) on an error", async () => {
    global.fetch = (async () => new Response("error", { status: 500 })) as unknown as typeof fetch;
    const tool = createGetCurrentlyPlayingTool(makeLinkedClient());
    const result = await tool.execute({}, context);
    expect(result.success).toBe(false);
  });
});

describe("PLAY_MUSIC tool", () => {
  test("is SAFE_ACTION", () => {
    const tool = createPlayMusicTool(makeLinkedClient());
    expect(tool.requiredPermission).toBe(PermissionLevel.SAFE_ACTION);
  });

  test("resumes playback when no query is given", async () => {
    global.fetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const tool = createPlayMusicTool(makeLinkedClient());
    const result = await tool.execute({}, context);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ resumed: true });
  });

  test("searches for and plays a track when a query is given", async () => {
    global.fetch = (async (url: string) => {
      if (url.includes("/search")) {
        return new Response(
          JSON.stringify({
            tracks: { items: [{ name: "Song", artists: [{ name: "Artist" }], album: { name: "Album" }, uri: "spotify:track:1" }] },
          }),
          { status: 200 }
        );
      }
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const tool = createPlayMusicTool(makeLinkedClient());
    const result = await tool.execute({ query: "Song" }, context);
    expect(result.success).toBe(true);
    expect((result.data as { track: { name: string } }).track.name).toBe("Song");
  });

  test("fails clearly when no track matches the query", async () => {
    global.fetch = (async () => new Response(JSON.stringify({ tracks: { items: [] } }), { status: 200 })) as unknown as typeof fetch;
    const tool = createPlayMusicTool(makeLinkedClient());
    const result = await tool.execute({ query: "nonexistent song" }, context);
    expect(result.success).toBe(false);
  });

  test("rejects an empty query", async () => {
    const tool = createPlayMusicTool(makeLinkedClient());
    const result = await tool.execute({ query: "" }, context);
    expect(result.success).toBe(false);
  });
});

describe("PAUSE_MUSIC tool", () => {
  test("is SAFE_ACTION and pauses playback", async () => {
    global.fetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const tool = createPauseMusicTool(makeLinkedClient());
    expect(tool.requiredPermission).toBe(PermissionLevel.SAFE_ACTION);
    const result = await tool.execute({}, context);
    expect(result.success).toBe(true);
  });
});

describe("SKIP_TRACK tool", () => {
  test("defaults to skipping forward", async () => {
    global.fetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const tool = createSkipTrackTool(makeLinkedClient());
    const result = await tool.execute({}, context);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ direction: "next" });
  });

  test("skips backward when asked", async () => {
    global.fetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const tool = createSkipTrackTool(makeLinkedClient());
    const result = await tool.execute({ direction: "previous" }, context);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ direction: "previous" });
  });

  test("rejects an invalid direction", async () => {
    const tool = createSkipTrackTool(makeLinkedClient());
    const result = await tool.execute({ direction: "sideways" as never }, context);
    expect(result.success).toBe(false);
  });
});

describe("UNLINK_SPOTIFY tool", () => {
  test("is DANGEROUS and clears the linked account", async () => {
    const tokenStore = new SpotifyTokenStore(":memory:");
    tokenStore.save({ refreshToken: "r1", accessToken: "a1", accessTokenExpiresAt: Date.now() + 3_600_000 });

    const tool = createUnlinkSpotifyTool(tokenStore);
    expect(tool.requiredPermission).toBe(PermissionLevel.DANGEROUS);

    const result = await tool.execute({}, context);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ wasLinked: true });
    expect(tokenStore.isLinked()).toBe(false);
  });
});
