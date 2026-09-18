import { describe, test, expect, afterEach } from "bun:test";
import { EventBus } from "@/core/events/EventBus";
import { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import { PairingService } from "@/devices/pairing/PairingService";
import { DeviceConnectionManager } from "@/communication/websocket/DeviceConnectionManager";
import { JarvisWebSocketServer } from "@/communication/websocket/JarvisWebSocketServer";

/**
 * Exercises the real ping/pong heartbeat over the actual Bun.serve
 * WebSocket server: a device registers, Core pings it, the (simulated)
 * Agent replies "pong" the same way `main.swift`'s real handler does, and
 * that reply's own arrival is confirmed to bump the device's `lastSeen` —
 * this is what, paired with the server's WebSocket `idleTimeout`, keeps a
 * genuinely healthy but quiet connection from being closed as idle.
 */
function setupServer() {
  const eventBus = new EventBus();
  const deviceRegistry = new DeviceRegistry();
  const pairingService = new PairingService();
  const deviceConnectionManager = new DeviceConnectionManager(eventBus);
  const server = new JarvisWebSocketServer({ deviceRegistry, deviceConnectionManager, pairingService, eventBus });
  const handle = server.start(0);
  return { handle, port: handle.port, deviceRegistry };
}

async function registerAndApprove(port: number, deviceId: string): Promise<WebSocket> {
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

  await fetch(`http://localhost:${port}/pairing/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId, code: pairingCode }),
  });

  return ws;
}

describe("Device heartbeat (ping/pong)", () => {
  let activeHandle: { stop: () => void } | undefined;
  let activeSocket: WebSocket | undefined;

  afterEach(() => {
    activeSocket?.close();
    activeSocket = undefined;
    activeHandle?.stop();
    activeHandle = undefined;
  });

  test("a pong reply bumps the device's lastSeen", async () => {
    const { handle, port, deviceRegistry } = setupServer();
    activeHandle = handle;

    const deviceId = "heartbeat-device-1";
    const ws = await registerAndApprove(port!, deviceId);
    activeSocket = ws;

    const beforeLastSeen = deviceRegistry.getDevice(deviceId)?.lastSeen;
    await new Promise((resolve) => setTimeout(resolve, 5));

    ws.send(
      JSON.stringify({
        requestId: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        deviceId,
        type: "pong",
        payload: {},
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    const afterLastSeen = deviceRegistry.getDevice(deviceId)?.lastSeen;
    expect(afterLastSeen).not.toBeNull();
    expect(afterLastSeen).not.toBe(beforeLastSeen);
  });

  test("a pong for an unregistered device is silently ignored, not an error", async () => {
    const { handle, port } = setupServer();
    activeHandle = handle;

    const ws = new WebSocket(`ws://localhost:${port}`);
    activeSocket = ws;
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("WebSocket error"));
      setTimeout(() => reject(new Error("Timed out opening socket")), 2000);
    });

    const errors: unknown[] = [];
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data as string);
      if (message.type === "error") errors.push(message);
    };

    ws.send(
      JSON.stringify({
        requestId: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        deviceId: "never-registered",
        type: "pong",
        payload: {},
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(errors).toHaveLength(0);
  });
});
