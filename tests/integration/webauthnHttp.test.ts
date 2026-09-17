import { describe, test, expect, afterEach } from "bun:test";
import { EventBus } from "@/core/events/EventBus";
import { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import { PairingService } from "@/devices/pairing/PairingService";
import { DeviceConnectionManager } from "@/communication/websocket/DeviceConnectionManager";
import { JarvisWebSocketServer } from "@/communication/websocket/JarvisWebSocketServer";
import { WebAuthnStore } from "@/auth/WebAuthnStore";
import { WebAuthnService } from "@/auth/WebAuthnService";
import { SessionStore } from "@/auth/SessionStore";

const ADMIN_TOKEN = "test-admin-secret";

function setupServer(options: { withAuth?: boolean } = {}) {
  const eventBus = new EventBus();
  const webAuthnService = options.withAuth ? new WebAuthnService(new WebAuthnStore()) : undefined;
  const sessionStore = options.withAuth ? new SessionStore() : undefined;
  const server = new JarvisWebSocketServer({
    deviceRegistry: new DeviceRegistry(),
    deviceConnectionManager: new DeviceConnectionManager(eventBus),
    pairingService: new PairingService(),
    eventBus,
    adminToken: ADMIN_TOKEN,
    webAuthnService,
    sessionStore,
  });
  const handle = server.start(0);
  return { handle, port: handle.port, webAuthnService, sessionStore };
}

describe("WebAuthn (Face ID / Touch ID) HTTP routes", () => {
  let activeHandle: { stop: () => void } | undefined;

  afterEach(() => {
    activeHandle?.stop();
    activeHandle = undefined;
  });

  test("/auth/* routes 404 when WebAuthn isn't configured", async () => {
    const { handle, port } = setupServer({ withAuth: false });
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/auth/login-options`);
    expect(response.status).toBe(404);
  });

  test("the dashboard is served openly when no credential is registered yet", async () => {
    const { handle, port } = setupServer({ withAuth: true });
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/`);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("JARVIS");
    expect(body).not.toContain("LOCKED");
  });

  test("register-options requires the admin token", async () => {
    const { handle, port } = setupServer({ withAuth: true });
    activeHandle = handle;

    const withoutToken = await fetch(`http://localhost:${port}/auth/register-options`, { method: "POST" });
    expect(withoutToken.status).toBe(401);

    const wrongToken = await fetch(`http://localhost:${port}/auth/register-options`, {
      method: "POST",
      headers: { "X-Jarvis-Admin-Token": "wrong" },
    });
    expect(wrongToken.status).toBe(401);

    const correctToken = await fetch(`http://localhost:${port}/auth/register-options`, {
      method: "POST",
      headers: { "X-Jarvis-Admin-Token": ADMIN_TOKEN },
    });
    expect(correctToken.status).toBe(200);
    const options = (await correctToken.json()) as { challenge: string; rp: { id: string } };
    expect(typeof options.challenge).toBe("string");
    expect(options.rp.id).toBe("localhost");
  });

  test("login-options requires no secret", async () => {
    const { handle, port } = setupServer({ withAuth: true });
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/auth/login-options`);
    expect(response.status).toBe(200);
    const options = (await response.json()) as { challenge: string };
    expect(typeof options.challenge).toBe("string");
  });

  test("the dashboard locks once a credential exists, until a valid session cookie is presented", async () => {
    // Simulate a credential having been registered (bypassing the real
    // browser ceremony, which is covered separately) so this test can
    // focus purely on the lock/unlock gating logic.
    const store = new WebAuthnStore();
    store.save({ id: "cred-1", publicKey: new Uint8Array([1, 2, 3]), counter: 0 });
    const webAuthnService = new WebAuthnService(store);
    const sessionStore = new SessionStore();

    const eventBus = new EventBus();
    const server = new JarvisWebSocketServer({
      deviceRegistry: new DeviceRegistry(),
      deviceConnectionManager: new DeviceConnectionManager(eventBus),
      pairingService: new PairingService(),
      eventBus,
      adminToken: ADMIN_TOKEN,
      webAuthnService,
      sessionStore,
    });
    const handle = server.start(0);
    activeHandle = handle;

    const lockedResponse = await fetch(`http://localhost:${handle.port}/`);
    const lockedBody = await lockedResponse.text();
    expect(lockedBody).toContain("LOCKED");

    const token = sessionStore.create();
    const unlockedResponse = await fetch(`http://localhost:${handle.port}/`, {
      headers: { Cookie: `jarvis_session=${token}` },
    });
    const unlockedBody = await unlockedResponse.text();
    expect(unlockedBody).not.toContain("LOCKED");
  });

  test("GET /status reports webAuthnConfigured based on whether a credential exists", async () => {
    const { handle, port } = setupServer({ withAuth: true });
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/status`);
    const data = (await response.json()) as { webAuthnConfigured: boolean };
    expect(data.webAuthnConfigured).toBe(false);
  });

  test("a malformed /auth/register body is rejected without crashing the server", async () => {
    const { handle, port } = setupServer({ withAuth: true });
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Jarvis-Admin-Token": ADMIN_TOKEN },
      body: "not json",
    });
    expect(response.status).toBe(400);
  });

  test("a login attempt with a bogus assertion is rejected, not crashed", async () => {
    const { handle, port } = setupServer({ withAuth: true });
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response: { id: "does-not-exist" } }),
    });
    expect(response.status).toBe(401);
  });
});
