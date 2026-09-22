import { describe, test, expect, afterEach } from "bun:test";
import { EventBus } from "@/core/events/EventBus";
import { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import { PairingService } from "@/devices/pairing/PairingService";
import { DeviceConnectionManager } from "@/communication/websocket/DeviceConnectionManager";
import { JarvisWebSocketServer } from "@/communication/websocket/JarvisWebSocketServer";
import type { Orchestrator } from "@/core/orchestrator/Orchestrator";

/**
 * ws(s)://.../chat previously checked the admin token but never went
 * through the rate limiter every other admin-gated route uses — an
 * attacker could brute force the token via unlimited upgrade attempts.
 * These prove the token check itself still works and that repeated wrong
 * guesses now get throttled the same way /backup, /pairing/approve, etc do.
 */
function setupServer(adminToken?: string) {
  const eventBus = new EventBus();
  const deviceRegistry = new DeviceRegistry();
  const pairingService = new PairingService();
  const deviceConnectionManager = new DeviceConnectionManager(eventBus);
  const server = new JarvisWebSocketServer({
    deviceRegistry,
    deviceConnectionManager,
    pairingService,
    eventBus,
    adminToken,
    webChatOrchestrator: {} as unknown as Orchestrator,
  });
  const handle = server.start(0);
  return { handle, port: handle.port };
}

describe("ws(s)://.../chat auth", () => {
  let activeHandle: { stop: () => void } | undefined;

  afterEach(() => {
    activeHandle?.stop();
    activeHandle = undefined;
  });

  test("rejects an upgrade with a wrong token", async () => {
    const { handle, port } = setupServer("secret-token");
    activeHandle = handle;

    const res = await fetch(`http://localhost:${port}/chat?token=wrong`, {
      headers: { Upgrade: "websocket", Connection: "Upgrade" },
    });
    expect(res.status).toBe(401);
  });

  test("rejects an upgrade that carries no token at all", async () => {
    // The case that actually matters on a LAN: Core listens on every
    // interface, so anything on the same Wi-Fi can reach /chat. Without
    // this, an omitted token read as "" would have to be compared against
    // the real one rather than waved through.
    const { handle, port } = setupServer("secret-token");
    activeHandle = handle;

    const res = await fetch(`http://localhost:${port}/chat`, {
      headers: { Upgrade: "websocket", Connection: "Upgrade" },
    });
    expect(res.status).toBe(401);
  });

  test("does not exempt loopback callers from the token check", async () => {
    // Every request in this suite already comes from 127.0.0.1, so a
    // "trust local connections" shortcut would silently pass all of the
    // above. Pinning it: being local is not a credential.
    const { handle, port } = setupServer("secret-token");
    activeHandle = handle;

    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      headers: { Upgrade: "websocket", Connection: "Upgrade" },
    });
    expect(res.status).toBe(401);
  });

  test("accepts an upgrade carrying the right token", async () => {
    const { handle, port } = setupServer("secret-token");
    activeHandle = handle;

    const res = await fetch(`http://localhost:${port}/chat?token=secret-token`, {
      headers: {
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    expect(res.status).toBe(101);
  });

  test("throttles repeated wrong-token upgrade attempts from the same caller", async () => {
    const { handle, port } = setupServer("secret-token");
    activeHandle = handle;

    const attempt = () =>
      fetch(`http://localhost:${port}/chat?token=wrong`, {
        headers: { Upgrade: "websocket", Connection: "Upgrade" },
      });

    const statuses: number[] = [];
    for (let i = 0; i < 15; i++) {
      statuses.push((await attempt()).status);
    }

    expect(statuses.every((s) => s === 401 || s === 429)).toBe(true);
    expect(statuses).toContain(429);
  });
});
