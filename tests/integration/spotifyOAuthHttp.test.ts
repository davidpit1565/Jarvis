import { describe, test, expect, afterEach } from "bun:test";
import { EventBus } from "@/core/events/EventBus";
import { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import { PairingService } from "@/devices/pairing/PairingService";
import { DeviceConnectionManager } from "@/communication/websocket/DeviceConnectionManager";
import { JarvisWebSocketServer } from "@/communication/websocket/JarvisWebSocketServer";
import { SpotifyTokenStore } from "@/spotify/SpotifyTokenStore";
import { SpotifyClient } from "@/spotify/SpotifyClient";

const ADMIN_TOKEN = "test-admin-secret";
const originalFetch = global.fetch;

let activeHandle: { stop: () => void } | undefined;

afterEach(() => {
  activeHandle?.stop();
  activeHandle = undefined;
  global.fetch = originalFetch;
});

function setupServer(opts: { spotifyClient?: SpotifyClient; adminToken?: string } = {}) {
  const eventBus = new EventBus();
  const server = new JarvisWebSocketServer({
    deviceRegistry: new DeviceRegistry(),
    deviceConnectionManager: new DeviceConnectionManager(eventBus),
    pairingService: new PairingService(),
    eventBus,
    adminToken: opts.adminToken,
    spotifyClient: opts.spotifyClient,
  });
  const handle = server.start(0);
  activeHandle = handle;
  return handle;
}

describe("GET /spotify/oauth/start", () => {
  test("404s when Spotify isn't configured", async () => {
    const handle = setupServer({ adminToken: ADMIN_TOKEN });
    const response = await fetch(`http://localhost:${handle.port}/spotify/oauth/start?token=${ADMIN_TOKEN}`, {
      redirect: "manual",
    });
    expect(response.status).toBe(404);
  });

  test("401s with a missing or wrong admin token", async () => {
    const tokenStore = new SpotifyTokenStore(":memory:");
    const spotifyClient = new SpotifyClient("id", "secret", "https://example.com/spotify/oauth/callback", tokenStore);
    const handle = setupServer({ adminToken: ADMIN_TOKEN, spotifyClient });

    const response = await fetch(`http://localhost:${handle.port}/spotify/oauth/start?token=wrong`, { redirect: "manual" });
    expect(response.status).toBe(401);
  });

  test("redirects to Spotify's consent screen with a valid admin token", async () => {
    const tokenStore = new SpotifyTokenStore(":memory:");
    const spotifyClient = new SpotifyClient("id", "secret", "https://example.com/spotify/oauth/callback", tokenStore);
    const handle = setupServer({ adminToken: ADMIN_TOKEN, spotifyClient });

    const response = await fetch(`http://localhost:${handle.port}/spotify/oauth/start?token=${ADMIN_TOKEN}`, {
      redirect: "manual",
    });

    expect(response.status).toBe(302);
    const location = response.headers.get("Location");
    expect(location).toContain("accounts.spotify.com");
    expect(location).toContain("client_id=id");
  });

  test("too many attempts from the same IP are rate-limited with 429", async () => {
    const tokenStore = new SpotifyTokenStore(":memory:");
    const spotifyClient = new SpotifyClient("id", "secret", "https://example.com/spotify/oauth/callback", tokenStore);
    const handle = setupServer({ adminToken: ADMIN_TOKEN, spotifyClient });

    let lastStatus = 0;
    for (let i = 0; i < 11; i++) {
      const response = await fetch(`http://localhost:${handle.port}/spotify/oauth/start?token=wrong`, {
        redirect: "manual",
      });
      lastStatus = response.status;
    }

    expect(lastStatus).toBe(429);
  });
});

describe("GET /spotify/oauth/callback", () => {
  test("404s when Spotify isn't configured", async () => {
    const handle = setupServer({ adminToken: ADMIN_TOKEN });
    const response = await fetch(`http://localhost:${handle.port}/spotify/oauth/callback?code=x&state=y`);
    expect(response.status).toBe(404);
  });

  test("rejects a callback with an unknown/expired state", async () => {
    const tokenStore = new SpotifyTokenStore(":memory:");
    const spotifyClient = new SpotifyClient("id", "secret", "https://example.com/spotify/oauth/callback", tokenStore);
    const handle = setupServer({ adminToken: ADMIN_TOKEN, spotifyClient });

    const response = await fetch(`http://localhost:${handle.port}/spotify/oauth/callback?code=x&state=never-issued`);
    expect(response.status).toBe(400);
  });

  test("surfaces a Spotify-reported error without crashing", async () => {
    const tokenStore = new SpotifyTokenStore(":memory:");
    const spotifyClient = new SpotifyClient("id", "secret", "https://example.com/spotify/oauth/callback", tokenStore);
    const handle = setupServer({ adminToken: ADMIN_TOKEN, spotifyClient });

    const response = await fetch(`http://localhost:${handle.port}/spotify/oauth/callback?error=access_denied`);
    expect(response.status).toBe(400);
  });

  test("completes the full start -> callback flow and links the account", async () => {
    const tokenStore = new SpotifyTokenStore(":memory:");
    const spotifyClient = new SpotifyClient("id", "secret", "https://example.com/spotify/oauth/callback", tokenStore);
    const handle = setupServer({ adminToken: ADMIN_TOKEN, spotifyClient });

    const startResponse = await fetch(`http://localhost:${handle.port}/spotify/oauth/start?token=${ADMIN_TOKEN}`, {
      redirect: "manual",
    });
    const state = new URL(startResponse.headers.get("Location")!).searchParams.get("state")!;

    global.fetch = (async (url: string, init?: RequestInit) =>
      url.includes("accounts.spotify.com")
        ? new Response(JSON.stringify({ access_token: "a1", refresh_token: "r1", expires_in: 3600 }), { status: 200 })
        : originalFetch(url, init)) as unknown as typeof fetch;

    const callbackResponse = await fetch(
      `http://localhost:${handle.port}/spotify/oauth/callback?code=auth-code&state=${state}`
    );

    expect(callbackResponse.status).toBe(200);
    expect(tokenStore.isLinked()).toBe(true);
  });

  test("a state can't be redeemed twice", async () => {
    const tokenStore = new SpotifyTokenStore(":memory:");
    const spotifyClient = new SpotifyClient("id", "secret", "https://example.com/spotify/oauth/callback", tokenStore);
    const handle = setupServer({ adminToken: ADMIN_TOKEN, spotifyClient });

    const startResponse = await fetch(`http://localhost:${handle.port}/spotify/oauth/start?token=${ADMIN_TOKEN}`, {
      redirect: "manual",
    });
    const state = new URL(startResponse.headers.get("Location")!).searchParams.get("state")!;

    global.fetch = (async (url: string, init?: RequestInit) =>
      url.includes("accounts.spotify.com")
        ? new Response(JSON.stringify({ access_token: "a1", refresh_token: "r1", expires_in: 3600 }), { status: 200 })
        : originalFetch(url, init)) as unknown as typeof fetch;

    await fetch(`http://localhost:${handle.port}/spotify/oauth/callback?code=auth-code&state=${state}`);
    const secondAttempt = await fetch(`http://localhost:${handle.port}/spotify/oauth/callback?code=auth-code&state=${state}`);

    expect(secondAttempt.status).toBe(400);
  });

  test("rejects a callback whose state has expired (past the 10-minute TTL)", async () => {
    const tokenStore = new SpotifyTokenStore(":memory:");
    const spotifyClient = new SpotifyClient("id", "secret", "https://example.com/spotify/oauth/callback", tokenStore);
    const handle = setupServer({ adminToken: ADMIN_TOKEN, spotifyClient });

    const startResponse = await fetch(`http://localhost:${handle.port}/spotify/oauth/start?token=${ADMIN_TOKEN}`, {
      redirect: "manual",
    });
    const state = new URL(startResponse.headers.get("Location")!).searchParams.get("state")!;

    const originalDateNow = Date.now;
    const realNow = Date.now();
    Date.now = () => realNow + 11 * 60 * 1000; // 11 minutes later — past the TTL

    const response = await fetch(`http://localhost:${handle.port}/spotify/oauth/callback?code=auth-code&state=${state}`);
    expect(response.status).toBe(400);

    Date.now = originalDateNow;
  });
});
