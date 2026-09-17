import { describe, test, expect, afterEach } from "bun:test";
import { EventBus } from "@/core/events/EventBus";
import { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import { PairingService } from "@/devices/pairing/PairingService";
import { DeviceConnectionManager } from "@/communication/websocket/DeviceConnectionManager";
import { JarvisWebSocketServer } from "@/communication/websocket/JarvisWebSocketServer";

/**
 * Exercises the real Bun.serve HTTP + WebSocket server end to end: a mock
 * device registers, receives a pairing code over the socket, and a
 * separate HTTP call (as the `approve-device` CLI would make) approves it
 * and confirms the credential is pushed back to the same open socket.
 */
function setupServer() {
  const eventBus = new EventBus();
  const deviceRegistry = new DeviceRegistry();
  const pairingService = new PairingService();
  const deviceConnectionManager = new DeviceConnectionManager(eventBus);
  const server = new JarvisWebSocketServer({ deviceRegistry, deviceConnectionManager, pairingService, eventBus });
  const handle = server.start(0); // port 0: let the OS pick a free port
  return { handle, port: handle.port, deviceRegistry, deviceConnectionManager, pairingService };
}

describe("Pairing approval over HTTP", () => {
  let activeHandle: { stop: () => void } | undefined;

  afterEach(() => {
    activeHandle?.stop();
    activeHandle = undefined;
  });

  test("a device receives its credential over the socket once approved via HTTP", async () => {
    const { handle, port } = setupServer();
    activeHandle = handle;

    const deviceId = "test-imac-1";
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
              deviceName: "Test iMac",
              deviceType: "mac",
              platform: "macos",
              agentVersion: "0.1.0",
              protocolVersion: "1",
              capabilities: [],
              requestedRole: "primary",
            },
          })
        );
      };
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data as string);
        if (message.payload?.command === "pairing.pending") {
          resolve(message.payload.args.code);
        }
      };
      ws.onerror = () => reject(new Error("WebSocket error"));
      setTimeout(() => reject(new Error("Timed out waiting for pairing.pending")), 2000);
    });

    expect(pairingCode).toMatch(/^\d{6}$/);

    const approvedMessagePromise = new Promise<{ credential?: string }>((resolve, reject) => {
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data as string);
        if (message.payload?.command === "pairing.approved") {
          resolve(message.payload.args ?? {});
        }
      };
      setTimeout(() => reject(new Error("Timed out waiting for pairing.approved")), 2000);
    });

    const httpResponse = await fetch(`http://localhost:${port}/pairing/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId, code: pairingCode }),
    });
    const httpBody = (await httpResponse.json()) as { success: boolean; credentialIssued: boolean };

    expect(httpResponse.status).toBe(200);
    expect(httpBody.success).toBe(true);
    expect(httpBody.credentialIssued).toBe(true);

    const approvedMessage = await approvedMessagePromise;
    expect(typeof approvedMessage.credential).toBe("string");
    expect((approvedMessage.credential as string).length).toBeGreaterThan(0);

    ws.close();
  });

  test("approving with the wrong code returns an HTTP error and does not authenticate the device", async () => {
    const { handle, port } = setupServer();
    activeHandle = handle;

    const deviceId = "test-imac-2";
    const ws = new WebSocket(`ws://localhost:${port}`);

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            requestId: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            deviceId,
            type: "device.register",
            payload: {
              deviceName: "Test iMac 2",
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
        if (message.payload?.command === "pairing.pending") resolve();
      };
      ws.onerror = () => reject(new Error("WebSocket error"));
      setTimeout(() => reject(new Error("Timed out waiting for pairing.pending")), 2000);
    });

    const httpResponse = await fetch(`http://localhost:${port}/pairing/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId, code: "000000" }),
    });
    const httpBody = (await httpResponse.json()) as { success: boolean; error?: string };

    expect(httpResponse.status).toBe(400);
    expect(httpBody.success).toBe(false);

    ws.close();
  });

  test("approving an unknown deviceId returns an HTTP error", async () => {
    const { handle, port } = setupServer();
    activeHandle = handle;

    const httpResponse = await fetch(`http://localhost:${port}/pairing/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: "never-registered", code: "123456" }),
    });
    const httpBody = (await httpResponse.json()) as { success: boolean };

    expect(httpResponse.status).toBe(400);
    expect(httpBody.success).toBe(false);
  });

  test("a malformed approval request body is rejected with 400", async () => {
    const { handle, port } = setupServer();
    activeHandle = handle;

    const httpResponse = await fetch(`http://localhost:${port}/pairing/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: 123 }),
    });

    expect(httpResponse.status).toBe(400);
  });
});
