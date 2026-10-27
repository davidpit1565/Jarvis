import { describe, test, expect, afterEach } from "bun:test";
import { EventBus } from "@/core/events/EventBus";
import { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import { PairingService } from "@/devices/pairing/PairingService";
import { DeviceConnectionManager } from "@/communication/websocket/DeviceConnectionManager";
import { JarvisWebSocketServer } from "@/communication/websocket/JarvisWebSocketServer";
import { CanvaTokenStore } from "@/canva/CanvaTokenStore";
import { CanvaClient } from "@/canva/CanvaClient";

const ADMIN_TOKEN = "test-admin-secret";
const originalFetch = global.fetch;

let activeHandle: { stop: () => void } | undefined;

afterEach(() => {
  activeHandle?.stop();
  activeHandle = undefined;
  global.fetch = originalFetch;
});

function setupServer(opts: { canvaClient?: CanvaClient; adminToken?: string } = {}) {
  const eventBus = new EventBus();
  const server = new JarvisWebSocketServer({
    deviceRegistry: new DeviceRegistry(),
    deviceConnectionManager: new DeviceConnectionManager(eventBus),
    pairingService: new PairingService(),
    eventBus,
    adminToken: opts.adminToken,
    canvaClient: opts.canvaClient,
  });
  const handle = server.start(0);
  activeHandle = handle;
  return handle;
}

describe("GET /canva/oauth/start", () => {
  test("404s when Canva isn't configured", async () => {
    const handle = setupServer({ adminToken: ADMIN_TOKEN });
    const response = await fetch(`http://localhost:${handle.port}/canva/oauth/start?token=${ADMIN_TOKEN}`, {
      redirect: "manual",
    });
    expect(response.status).toBe(404);
  });

  test("401s with a missing or wrong admin token", async () => {
    const tokenStore = new CanvaTokenStore(":memory:");
    const canvaClient = new CanvaClient("id", "secret", "https://example.com/canva/oauth/callback", tokenStore);
    const handle = setupServer({ adminToken: ADMIN_TOKEN, canvaClient });

    const response = await fetch(`http://localhost:${handle.port}/canva/oauth/start?token=wrong`, { redirect: "manual" });
    expect(response.status).toBe(401);
  });

  test("redirects to Canva's consent screen with a PKCE code_challenge", async () => {
    const tokenStore = new CanvaTokenStore(":memory:");
    const canvaClient = new CanvaClient("id", "secret", "https://example.com/canva/oauth/callback", tokenStore);
    const handle = setupServer({ adminToken: ADMIN_TOKEN, canvaClient });

    const response = await fetch(`http://localhost:${handle.port}/canva/oauth/start?token=${ADMIN_TOKEN}`, {
      redirect: "manual",
    });

    expect(response.status).toBe(302);
    const location = response.headers.get("Location")!;
    expect(location).toContain("www.canva.com");
    expect(location).toContain("client_id=id");
    expect(new URL(location).searchParams.get("code_challenge")).toBeTruthy();
  });

  test("too many attempts from the same IP are rate-limited with 429", async () => {
    const tokenStore = new CanvaTokenStore(":memory:");
    const canvaClient = new CanvaClient("id", "secret", "https://example.com/canva/oauth/callback", tokenStore);
    const handle = setupServer({ adminToken: ADMIN_TOKEN, canvaClient });

    let lastStatus = 0;
    for (let i = 0; i < 11; i++) {
      const response = await fetch(`http://localhost:${handle.port}/canva/oauth/start?token=wrong`, { redirect: "manual" });
      lastStatus = response.status;
    }

    expect(lastStatus).toBe(429);
  });
});

describe("GET /canva/oauth/callback", () => {
  test("404s when Canva isn't configured", async () => {
    const handle = setupServer({ adminToken: ADMIN_TOKEN });
    const response = await fetch(`http://localhost:${handle.port}/canva/oauth/callback?code=x&state=y`);
    expect(response.status).toBe(404);
  });

  test("rejects a callback with an unknown/expired state", async () => {
    const tokenStore = new CanvaTokenStore(":memory:");
    const canvaClient = new CanvaClient("id", "secret", "https://example.com/canva/oauth/callback", tokenStore);
    const handle = setupServer({ adminToken: ADMIN_TOKEN, canvaClient });

    const response = await fetch(`http://localhost:${handle.port}/canva/oauth/callback?code=x&state=never-issued`);
    expect(response.status).toBe(400);
  });

  test("surfaces a Canva-reported error without crashing", async () => {
    const tokenStore = new CanvaTokenStore(":memory:");
    const canvaClient = new CanvaClient("id", "secret", "https://example.com/canva/oauth/callback", tokenStore);
    const handle = setupServer({ adminToken: ADMIN_TOKEN, canvaClient });

    const response = await fetch(`http://localhost:${handle.port}/canva/oauth/callback?error=access_denied`);
    expect(response.status).toBe(400);
  });

  test("completes the full start -> callback flow, sending back the matching code_verifier", async () => {
    const tokenStore = new CanvaTokenStore(":memory:");
    const canvaClient = new CanvaClient("id", "secret", "https://example.com/canva/oauth/callback", tokenStore);
    const handle = setupServer({ adminToken: ADMIN_TOKEN, canvaClient });

    const startResponse = await fetch(`http://localhost:${handle.port}/canva/oauth/start?token=${ADMIN_TOKEN}`, {
      redirect: "manual",
    });
    const location = new URL(startResponse.headers.get("Location")!);
    const state = location.searchParams.get("state")!;

    let capturedVerifier = "";
    global.fetch = (async (url: string, init?: RequestInit) => {
      if (url.includes("oauth/token")) {
        capturedVerifier = new URLSearchParams(init?.body as string).get("code_verifier") ?? "";
        return new Response(JSON.stringify({ access_token: "a1", refresh_token: "r1", expires_in: 14400 }), { status: 200 });
      }
      return originalFetch(url, init);
    }) as unknown as typeof fetch;

    const callbackResponse = await fetch(
      `http://localhost:${handle.port}/canva/oauth/callback?code=auth-code&state=${state}`
    );

    expect(callbackResponse.status).toBe(200);
    expect(tokenStore.isLinked()).toBe(true);
    expect(capturedVerifier.length).toBeGreaterThan(0);
  });

  test("a state can't be redeemed twice", async () => {
    const tokenStore = new CanvaTokenStore(":memory:");
    const canvaClient = new CanvaClient("id", "secret", "https://example.com/canva/oauth/callback", tokenStore);
    const handle = setupServer({ adminToken: ADMIN_TOKEN, canvaClient });

    const startResponse = await fetch(`http://localhost:${handle.port}/canva/oauth/start?token=${ADMIN_TOKEN}`, {
      redirect: "manual",
    });
    const state = new URL(startResponse.headers.get("Location")!).searchParams.get("state")!;

    global.fetch = (async (url: string, init?: RequestInit) =>
      url.includes("oauth/token")
        ? new Response(JSON.stringify({ access_token: "a1", refresh_token: "r1", expires_in: 14400 }), { status: 200 })
        : originalFetch(url, init)) as unknown as typeof fetch;

    await fetch(`http://localhost:${handle.port}/canva/oauth/callback?code=auth-code&state=${state}`);
    const secondAttempt = await fetch(`http://localhost:${handle.port}/canva/oauth/callback?code=auth-code&state=${state}`);

    expect(secondAttempt.status).toBe(400);
  });

  test("rejects a callback whose state has expired (past the 10-minute TTL)", async () => {
    const tokenStore = new CanvaTokenStore(":memory:");
    const canvaClient = new CanvaClient("id", "secret", "https://example.com/canva/oauth/callback", tokenStore);
    const handle = setupServer({ adminToken: ADMIN_TOKEN, canvaClient });

    const startResponse = await fetch(`http://localhost:${handle.port}/canva/oauth/start?token=${ADMIN_TOKEN}`, {
      redirect: "manual",
    });
    const state = new URL(startResponse.headers.get("Location")!).searchParams.get("state")!;

    const originalDateNow = Date.now;
    const realNow = Date.now();
    Date.now = () => realNow + 11 * 60 * 1000; // 11 minutes later — past the TTL

    const response = await fetch(`http://localhost:${handle.port}/canva/oauth/callback?code=auth-code&state=${state}`);
    expect(response.status).toBe(400);

    Date.now = originalDateNow;
  });
});
