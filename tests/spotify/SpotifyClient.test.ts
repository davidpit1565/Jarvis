import { describe, test, expect, afterEach } from "bun:test";
import { SpotifyTokenStore } from "@/spotify/SpotifyTokenStore";
import { SpotifyClient } from "@/spotify/SpotifyClient";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function makeClient(tokenStore = new SpotifyTokenStore(":memory:")) {
  return { client: new SpotifyClient("client-id", "client-secret", "https://example.com/spotify/oauth/callback", tokenStore), tokenStore };
}

function makeLinkedTokenStore(): SpotifyTokenStore {
  const tokenStore = new SpotifyTokenStore(":memory:");
  tokenStore.save({ refreshToken: "r1", accessToken: "valid", accessTokenExpiresAt: Date.now() + 3_600_000 });
  return tokenStore;
}

describe("SpotifyClient.buildAuthUrl", () => {
  test("includes client id, redirect uri, and state", () => {
    const { client } = makeClient();
    const url = new URL(client.buildAuthUrl("state-123"));
    expect(url.hostname).toBe("accounts.spotify.com");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("https://example.com/spotify/oauth/callback");
    expect(url.searchParams.get("state")).toBe("state-123");
  });
});

describe("SpotifyClient.exchangeCodeForTokens", () => {
  test("persists tokens on success", async () => {
    const { client, tokenStore } = makeClient();
    global.fetch = (async () =>
      new Response(JSON.stringify({ access_token: "a1", refresh_token: "r1", expires_in: 3600 }), { status: 200 })) as unknown as typeof fetch;

    await client.exchangeCodeForTokens("code-1");
    expect(tokenStore.isLinked()).toBe(true);
  });

  test("throws when Spotify doesn't return a refresh token", async () => {
    const { client } = makeClient();
    global.fetch = (async () =>
      new Response(JSON.stringify({ access_token: "a1", expires_in: 3600 }), { status: 200 })) as unknown as typeof fetch;

    await expect(client.exchangeCodeForTokens("code-1")).rejects.toThrow(/refresh token/i);
  });

  test("throws on a non-2xx response", async () => {
    const { client } = makeClient();
    global.fetch = (async () => new Response("bad request", { status: 400 })) as unknown as typeof fetch;
    await expect(client.exchangeCodeForTokens("code-1")).rejects.toThrow(/400/);
  });
});

describe("SpotifyClient.getPlaybackState", () => {
  test("throws when no account is linked", async () => {
    const { client } = makeClient();
    await expect(client.getPlaybackState()).rejects.toThrow(/no spotify account linked/i);
  });

  test("returns nothing playing on a 204", async () => {
    const { client } = makeClient(makeLinkedTokenStore());
    global.fetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;

    const state = await client.getPlaybackState();
    expect(state).toEqual({ isPlaying: false, track: null, deviceName: null });
  });

  test("returns the current track and device when something is playing", async () => {
    const { client } = makeClient(makeLinkedTokenStore());
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          is_playing: true,
          device: { name: "David's MacBook" },
          item: { name: "Song", artists: [{ name: "Artist" }], album: { name: "Album" }, uri: "spotify:track:1" },
        }),
        { status: 200 }
      )) as unknown as typeof fetch;

    const state = await client.getPlaybackState();
    expect(state).toEqual({
      isPlaying: true,
      deviceName: "David's MacBook",
      track: { name: "Song", artists: ["Artist"], album: "Album", uri: "spotify:track:1" },
    });
  });

  test("refreshes an expired access token before requesting", async () => {
    const tokenStore = new SpotifyTokenStore(":memory:");
    tokenStore.save({ refreshToken: "refresh-1", accessToken: "expired", accessTokenExpiresAt: Date.now() - 1000 });
    const { client } = makeClient(tokenStore);

    global.fetch = (async (url: string, init?: RequestInit) => {
      if (url.includes("accounts.spotify.com")) {
        return new Response(JSON.stringify({ access_token: "refreshed-token", expires_in: 3600 }), { status: 200 });
      }
      expect((init?.headers as Record<string, string>)?.Authorization).toBe("Bearer refreshed-token");
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    await client.getPlaybackState();
  });
});

describe("SpotifyClient playback controls", () => {
  test("play() resumes without a body when no trackUri is given", async () => {
    const { client } = makeClient(makeLinkedTokenStore());
    let capturedBody: unknown;
    global.fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body;
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    await client.play();
    expect(capturedBody).toBeUndefined();
  });

  test("play(trackUri) sends the track uri", async () => {
    const { client } = makeClient(makeLinkedTokenStore());
    let capturedBody: unknown;
    global.fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body;
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    await client.play("spotify:track:1");
    expect(JSON.parse(capturedBody as string)).toEqual({ uris: ["spotify:track:1"] });
  });

  test("pause() throws on failure", async () => {
    const { client } = makeClient(makeLinkedTokenStore());
    global.fetch = (async () => new Response("no active device", { status: 404 })) as unknown as typeof fetch;
    await expect(client.pause()).rejects.toThrow(/404/);
  });

  test("skipToNext() and skipToPrevious() both succeed on 204", async () => {
    const { client } = makeClient(makeLinkedTokenStore());
    global.fetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    await expect(client.skipToNext()).resolves.toBeUndefined();
    await expect(client.skipToPrevious()).resolves.toBeUndefined();
  });
});

describe("SpotifyClient.searchTracks", () => {
  test("returns matching tracks", async () => {
    const { client } = makeClient(makeLinkedTokenStore());
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          tracks: {
            items: [{ name: "Bohemian Rhapsody", artists: [{ name: "Queen" }], album: { name: "A Night at the Opera" }, uri: "spotify:track:2" }],
          },
        }),
        { status: 200 }
      )) as unknown as typeof fetch;

    const results = await client.searchTracks("bohemian rhapsody");
    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe("Bohemian Rhapsody");
    expect(results[0]?.artists).toEqual(["Queen"]);
  });

  test("caps the requested limit", async () => {
    const { client } = makeClient(makeLinkedTokenStore());
    let requestedLimit = "";
    global.fetch = (async (url: string) => {
      requestedLimit = new URL(url).searchParams.get("limit") ?? "";
      return new Response(JSON.stringify({ tracks: { items: [] } }), { status: 200 });
    }) as unknown as typeof fetch;

    await client.searchTracks("query", 100);
    expect(requestedLimit).toBe("10");
  });
});

describe("SpotifyClient.listPlaylists / findPlaylistByName", () => {
  test("listPlaylists parses the user's own playlists", async () => {
    const { client } = makeClient(makeLinkedTokenStore());
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          items: [{ name: "Workout Mix", owner: { display_name: "David" }, tracks: { total: 42 }, uri: "spotify:playlist:1" }],
        }),
        { status: 200 }
      )) as unknown as typeof fetch;

    const playlists = await client.listPlaylists();
    expect(playlists).toEqual([{ name: "Workout Mix", ownerName: "David", trackCount: 42, uri: "spotify:playlist:1" }]);
  });

  test("findPlaylistByName matches case-insensitively, exact match preferred", async () => {
    const { client } = makeClient(makeLinkedTokenStore());
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          items: [
            { name: "Workout", owner: null, tracks: { total: 5 }, uri: "spotify:playlist:1" },
            { name: "Morning Workout Mix", owner: null, tracks: { total: 20 }, uri: "spotify:playlist:2" },
          ],
        }),
        { status: 200 }
      )) as unknown as typeof fetch;

    const found = await client.findPlaylistByName("workout");
    expect(found?.uri).toBe("spotify:playlist:1");
  });

  test("findPlaylistByName falls back to a substring match", async () => {
    const { client } = makeClient(makeLinkedTokenStore());
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          items: [{ name: "Morning Workout Mix", owner: null, tracks: { total: 20 }, uri: "spotify:playlist:2" }],
        }),
        { status: 200 }
      )) as unknown as typeof fetch;

    const found = await client.findPlaylistByName("workout");
    expect(found?.uri).toBe("spotify:playlist:2");
  });

  test("findPlaylistByName returns null when nothing matches", async () => {
    const { client } = makeClient(makeLinkedTokenStore());
    global.fetch = (async () => new Response(JSON.stringify({ items: [] }), { status: 200 })) as unknown as typeof fetch;

    const found = await client.findPlaylistByName("nonexistent");
    expect(found).toBeNull();
  });
});

describe("SpotifyClient.playContext", () => {
  test("sends context_uri, not uris, distinguishing a playlist from a track", async () => {
    const { client } = makeClient(makeLinkedTokenStore());
    let capturedBody: Record<string, unknown> | undefined;
    global.fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    await client.playContext("spotify:playlist:1");
    expect(capturedBody).toEqual({ context_uri: "spotify:playlist:1" });
  });
});
