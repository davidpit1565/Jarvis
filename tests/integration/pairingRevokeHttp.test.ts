import { describe, test, expect, afterEach } from "bun:test";
import { EventBus } from "@/core/events/EventBus";
import { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import { PairingService } from "@/devices/pairing/PairingService";
import { DeviceConnectionManager } from "@/communication/websocket/DeviceConnectionManager";
import { JarvisWebSocketServer } from "@/communication/websocket/JarvisWebSocketServer";

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
  });
  const handle = server.start(0);
  return { handle, port: handle.port, pairingService, deviceConnectionManager };
}

/** Registers a device, waits for its pairing code, approves it, and returns its credential. */
async function registerAndPair(port: number, deviceId: string): Promise<{ ws: WebSocket; credential: string }> {
  const ws = new WebSocket(`ws://localhost:${port}`);

  const pairingCode = await new Promise<string>((resolve, reject) => {
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          requestId: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          deviceId,
          type: "device.register",
          payload: {
            deviceName: "Test device",
            deviceType: "mac",
            platform: "macos",
            agentVersion: "0.1.0",
            protocolVersion: "1",
            capabilities: [],
          },
        })
      );
    };
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data as string);
      if (message.payload?.command === "pairing.pending") resolve(message.payload.args.code);
    };
    ws.onerror = () => reject(new Error("WebSocket error"));
    setTimeout(() => reject(new Error("Timed out waiting for pairing.pending")), 2000);
  });

  const credential = await new Promise<string>((resolve, reject) => {
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data as string);
      if (message.payload?.command === "pairing.approved") resolve(message.payload.args.credential);
    };
    fetch(`http://localhost:${port}/pairing/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId, code: pairingCode }),
    }).catch(reject);
    setTimeout(() => reject(new Error("Timed out waiting for pairing.approved")), 2000);
  });

  return { ws, credential };
}

describe("Device revocation over HTTP", () => {
  let activeHandle: { stop: () => void } | undefined;

  afterEach(() => {
    activeHandle?.stop();
    activeHandle = undefined;
  });

  test("a revoked device can no longer reconnect with its old credential", async () => {
    const { handle, port } = setupServer();
    activeHandle = handle;
    const deviceId = "revoke-me";

    const { ws, credential } = await registerAndPair(port!, deviceId);
    ws.close();

    const revokeResponse = await fetch(`http://localhost:${port}/pairing/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId }),
    });
    expect(revokeResponse.status).toBe(200);

    const ws2 = new WebSocket(`ws://localhost:${port}`);
    const outcome = await new Promise<string>((resolve, reject) => {
      ws2.onopen = () => {
        ws2.send(
          JSON.stringify({
            requestId: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            deviceId,
            type: "device.register",
            payload: {
              deviceName: "Test device",
              deviceType: "mac",
              platform: "macos",
              agentVersion: "0.1.0",
              protocolVersion: "1",
              capabilities: [],
              credential,
            },
          })
        );
      };
      ws2.onmessage = (event) => {
        const message = JSON.parse(event.data as string);
        resolve(message.payload?.command);
      };
      ws2.onerror = () => reject(new Error("WebSocket error"));
      setTimeout(() => reject(new Error("Timed out")), 2000);
    });

    expect(outcome).toBe("pairing.pending"); // bounced back to re-pair, not accepted
    ws2.close();
  });

  test("revoking an active connection actually closes its socket", async () => {
    const { handle, port } = setupServer();
    activeHandle = handle;
    const deviceId = "revoke-live";

    const { ws } = await registerAndPair(port!, deviceId);

    const closed = new Promise<void>((resolve) => {
      ws.onclose = () => resolve();
    });

    await fetch(`http://localhost:${port}/pairing/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId }),
    });

    await closed; // resolves only if the server actually closed the socket
  });

  test("requires the admin token when one is configured", async () => {
    const { handle, port } = setupServer("correct-admin-secret");
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/pairing/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: "some-device" }),
    });

    expect(response.status).toBe(401);
  });

  test("succeeds with the correct admin token", async () => {
    const { handle, port } = setupServer("correct-admin-secret");
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/pairing/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Jarvis-Admin-Token": "correct-admin-secret" },
      body: JSON.stringify({ deviceId: "some-device" }),
    });

    expect(response.status).toBe(200);
  });

  test("rejects a malformed body", async () => {
    const { handle, port } = setupServer();
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/pairing/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
  });
});
