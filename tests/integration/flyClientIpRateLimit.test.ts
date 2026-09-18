import { describe, test, expect, afterEach } from "bun:test";
import { EventBus } from "@/core/events/EventBus";
import { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import { PairingService } from "@/devices/pairing/PairingService";
import { DeviceConnectionManager } from "@/communication/websocket/DeviceConnectionManager";
import { JarvisWebSocketServer } from "@/communication/websocket/JarvisWebSocketServer";

const originalFlyAppName = process.env.FLY_APP_NAME;

/**
 * Behind Fly.io's proxy, every request's raw socket address is Fly's own
 * internal hop, not the real caller's IP — without honoring the
 * `Fly-Client-IP` header, every caller would share one rate-limit bucket
 * per route. These tests simulate that by setting the header directly
 * (there's no real Fly proxy in a test harness) and confirm two different
 * claimed client IPs get independent rate-limit buckets, while repeated
 * requests from the *same* claimed IP still share one.
 *
 * The header is only honored when FLY_APP_NAME (which Fly sets on every
 * real Machine automatically) is present — otherwise this same Dockerfile
 * running on Railway/Render/a plain VPS would let any caller set an
 * arbitrary Fly-Client-IP value and get a fresh bucket on every request,
 * bypassing the rate limit entirely.
 */
describe("Fly-Client-IP-aware rate limiting", () => {
  let activeHandle: { stop: () => void } | undefined;

  afterEach(() => {
    activeHandle?.stop();
    activeHandle = undefined;
    if (originalFlyAppName === undefined) delete process.env.FLY_APP_NAME;
    else process.env.FLY_APP_NAME = originalFlyAppName;
  });

  function setupServer() {
    const eventBus = new EventBus();
    const server = new JarvisWebSocketServer({
      deviceRegistry: new DeviceRegistry(),
      deviceConnectionManager: new DeviceConnectionManager(eventBus),
      pairingService: new PairingService(),
      eventBus,
      adminToken: "secret-token",
    });
    const handle = server.start(0);
    activeHandle = handle;
    return handle;
  }

  test("two distinct Fly-Client-IP values get independent rate-limit buckets, when actually running on Fly", async () => {
    process.env.FLY_APP_NAME = "jarvis-core";
    const handle = setupServer();

    const hitWith = (ip: string) =>
      fetch(`http://localhost:${handle.port}/backup`, {
        headers: { "Fly-Client-IP": ip, "X-Jarvis-Admin-Token": "wrong" },
      });

    // Exhaust the 10-attempts-per-5-minutes bucket for the first claimed IP.
    for (let i = 0; i < 10; i++) {
      const response = await hitWith("1.1.1.1");
      expect(response.status).toBe(401); // wrong token, but still within the limit
    }

    const eleventhFromFirstIp = await hitWith("1.1.1.1");
    expect(eleventhFromFirstIp.status).toBe(429);

    // A different claimed IP is a separate bucket — not yet exhausted.
    const firstFromSecondIp = await hitWith("2.2.2.2");
    expect(firstFromSecondIp.status).toBe(401);
  });

  test("ignores a client-supplied Fly-Client-IP header when NOT running on Fly (rate-limit bypass prevention)", async () => {
    delete process.env.FLY_APP_NAME;
    const handle = setupServer();

    const hitWith = (ip: string) =>
      fetch(`http://localhost:${handle.port}/backup`, {
        headers: { "Fly-Client-IP": ip, "X-Jarvis-Admin-Token": "wrong" },
      });

    // Exhaust the bucket while claiming a different (fake) IP on every request.
    for (let i = 0; i < 10; i++) {
      const response = await hitWith(`10.0.0.${i}`);
      expect(response.status).toBe(401);
    }

    // Without FLY_APP_NAME, every request shares the same real-socket-based
    // bucket regardless of the claimed header — the 11th request, with yet
    // another fake IP, is still rate-limited.
    const eleventh = await hitWith("10.0.0.99");
    expect(eleventh.status).toBe(429);
  });
});
