import { describe, test, expect, afterEach } from "bun:test";
import { EventBus } from "@/core/events/EventBus";
import { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import { PairingService } from "@/devices/pairing/PairingService";
import { DeviceConnectionManager } from "@/communication/websocket/DeviceConnectionManager";
import { JarvisWebSocketServer } from "@/communication/websocket/JarvisWebSocketServer";
import { CalendarTokenStore } from "@/calendar/CalendarTokenStore";
import { GoogleCalendarClient } from "@/calendar/GoogleCalendarClient";

const ADMIN_TOKEN = "test-admin-secret";
const originalFetch = global.fetch;
const originalDateNow = Date.now;

let activeHandle: { stop: () => void } | undefined;

afterEach(() => {
  Date.now = originalDateNow;
  activeHandle?.stop();
  activeHandle = undefined;
  global.fetch = originalFetch;
});

function setupServer(opts: { calendarClient?: GoogleCalendarClient; adminToken?: string } = {}) {
  const eventBus = new EventBus();
  const server = new JarvisWebSocketServer({
    deviceRegistry: new DeviceRegistry(),
    deviceConnectionManager: new DeviceConnectionManager(eventBus),
    pairingService: new PairingService(),
    eventBus,
    adminToken: opts.adminToken,
    calendarClient: opts.calendarClient,
  });
  const handle = server.start(0);
  activeHandle = handle;
  return handle;
}

describe("GET /calendar/oauth/start", () => {
  test("404s when calendar isn't configured", async () => {
    const handle = setupServer({ adminToken: ADMIN_TOKEN });
    const response = await fetch(`http://localhost:${handle.port}/calendar/oauth/start?token=${ADMIN_TOKEN}`, {
      redirect: "manual",
    });
    expect(response.status).toBe(404);
  });

  test("401s with a missing or wrong admin token", async () => {
    const tokenStore = new CalendarTokenStore(":memory:");
    const calendarClient = new GoogleCalendarClient("id", "secret", "https://example.com/calendar/oauth/callback", tokenStore);
    const handle = setupServer({ adminToken: ADMIN_TOKEN, calendarClient });

    const response = await fetch(`http://localhost:${handle.port}/calendar/oauth/start?token=wrong`, { redirect: "manual" });
    expect(response.status).toBe(401);
  });

  test("redirects to Google's consent screen with a valid admin token", async () => {
    const tokenStore = new CalendarTokenStore(":memory:");
    const calendarClient = new GoogleCalendarClient("id", "secret", "https://example.com/calendar/oauth/callback", tokenStore);
    const handle = setupServer({ adminToken: ADMIN_TOKEN, calendarClient });

    const response = await fetch(`http://localhost:${handle.port}/calendar/oauth/start?token=${ADMIN_TOKEN}`, {
      redirect: "manual",
    });

    expect(response.status).toBe(302);
    const location = response.headers.get("Location");
    expect(location).toContain("accounts.google.com");
    expect(location).toContain("client_id=id");
  });

  test("too many attempts from the same IP are rate-limited with 429", async () => {
    const tokenStore = new CalendarTokenStore(":memory:");
    const calendarClient = new GoogleCalendarClient("id", "secret", "https://example.com/calendar/oauth/callback", tokenStore);
    const handle = setupServer({ adminToken: ADMIN_TOKEN, calendarClient });

    let lastStatus = 0;
    for (let i = 0; i < 11; i++) {
      const response = await fetch(`http://localhost:${handle.port}/calendar/oauth/start?token=wrong`, {
        redirect: "manual",
      });
      lastStatus = response.status;
    }

    expect(lastStatus).toBe(429);
  });
});

describe("GET /calendar/oauth/callback", () => {
  test("404s when calendar isn't configured", async () => {
    const handle = setupServer({ adminToken: ADMIN_TOKEN });
    const response = await fetch(`http://localhost:${handle.port}/calendar/oauth/callback?code=x&state=y`);
    expect(response.status).toBe(404);
  });

  test("rejects a callback with an unknown/expired state", async () => {
    const tokenStore = new CalendarTokenStore(":memory:");
    const calendarClient = new GoogleCalendarClient("id", "secret", "https://example.com/calendar/oauth/callback", tokenStore);
    const handle = setupServer({ adminToken: ADMIN_TOKEN, calendarClient });

    const response = await fetch(`http://localhost:${handle.port}/calendar/oauth/callback?code=x&state=never-issued`);
    expect(response.status).toBe(400);
  });

  test("surfaces a Google-reported error without crashing", async () => {
    const tokenStore = new CalendarTokenStore(":memory:");
    const calendarClient = new GoogleCalendarClient("id", "secret", "https://example.com/calendar/oauth/callback", tokenStore);
    const handle = setupServer({ adminToken: ADMIN_TOKEN, calendarClient });

    const response = await fetch(`http://localhost:${handle.port}/calendar/oauth/callback?error=access_denied`);
    expect(response.status).toBe(400);
  });

  test("completes the full start -> callback flow and links the account", async () => {
    const tokenStore = new CalendarTokenStore(":memory:");
    const calendarClient = new GoogleCalendarClient("id", "secret", "https://example.com/calendar/oauth/callback", tokenStore);
    const handle = setupServer({ adminToken: ADMIN_TOKEN, calendarClient });

    const startResponse = await fetch(`http://localhost:${handle.port}/calendar/oauth/start?token=${ADMIN_TOKEN}`, {
      redirect: "manual",
    });
    const state = new URL(startResponse.headers.get("Location")!).searchParams.get("state")!;

    global.fetch = (async (url: string, init?: RequestInit) => {
      if (url.includes("oauth2.googleapis.com")) {
        return new Response(JSON.stringify({ access_token: "a1", refresh_token: "r1", expires_in: 3600 }), { status: 200 });
      }
      if (url.includes("userinfo")) {
        return new Response(JSON.stringify({ email: "me@example.com" }), { status: 200 });
      }
      return originalFetch(url, init);
    }) as unknown as typeof fetch;

    const callbackResponse = await fetch(
      `http://localhost:${handle.port}/calendar/oauth/callback?code=auth-code&state=${state}`
    );

    expect(callbackResponse.status).toBe(200);
    expect(await callbackResponse.text()).toContain("me@example.com");
    expect(tokenStore.isLinked("me@example.com")).toBe(true);
  });

  test("a state can't be redeemed twice", async () => {
    const tokenStore = new CalendarTokenStore(":memory:");
    const calendarClient = new GoogleCalendarClient("id", "secret", "https://example.com/calendar/oauth/callback", tokenStore);
    const handle = setupServer({ adminToken: ADMIN_TOKEN, calendarClient });

    const startResponse = await fetch(`http://localhost:${handle.port}/calendar/oauth/start?token=${ADMIN_TOKEN}`, {
      redirect: "manual",
    });
    const state = new URL(startResponse.headers.get("Location")!).searchParams.get("state")!;

    global.fetch = (async (url: string, init?: RequestInit) => {
      if (url.includes("oauth2.googleapis.com")) {
        return new Response(JSON.stringify({ access_token: "a1", refresh_token: "r1", expires_in: 3600 }), { status: 200 });
      }
      if (url.includes("userinfo")) {
        return new Response(JSON.stringify({ email: "me@example.com" }), { status: 200 });
      }
      return originalFetch(url, init);
    }) as unknown as typeof fetch;

    await fetch(`http://localhost:${handle.port}/calendar/oauth/callback?code=auth-code&state=${state}`);
    const secondAttempt = await fetch(`http://localhost:${handle.port}/calendar/oauth/callback?code=auth-code&state=${state}`);

    expect(secondAttempt.status).toBe(400);
  });

  test("rejects a callback whose state has expired (past the 10-minute TTL)", async () => {
    const tokenStore = new CalendarTokenStore(":memory:");
    const calendarClient = new GoogleCalendarClient("id", "secret", "https://example.com/calendar/oauth/callback", tokenStore);
    const handle = setupServer({ adminToken: ADMIN_TOKEN, calendarClient });

    const startResponse = await fetch(`http://localhost:${handle.port}/calendar/oauth/start?token=${ADMIN_TOKEN}`, {
      redirect: "manual",
    });
    const state = new URL(startResponse.headers.get("Location")!).searchParams.get("state")!;

    const realNow = Date.now();
    Date.now = () => realNow + 11 * 60 * 1000; // 11 minutes later — past the TTL

    const response = await fetch(`http://localhost:${handle.port}/calendar/oauth/callback?code=auth-code&state=${state}`);
    expect(response.status).toBe(400);
  });
});
