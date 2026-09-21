import { describe, test, expect, afterEach } from "bun:test";
import { EventBus } from "@/core/events/EventBus";
import { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import { PairingService } from "@/devices/pairing/PairingService";
import { DeviceConnectionManager } from "@/communication/websocket/DeviceConnectionManager";
import { JarvisWebSocketServer } from "@/communication/websocket/JarvisWebSocketServer";

/**
 * Exercises `device.capabilities` (capability discovery / live permission
 * status — roadmap #79/#80) over the real Bun.serve WebSocket server: a
 * device registers, then reports its own permission state the way the
 * Swift Agent's `CapabilityReporter` does on connect, and Core is expected
 * to store it on `DeviceRegistry` without needing a tool call to fail
 * first to learn it.
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

describe("device.capabilities (capability discovery / permission status)", () => {
  let activeHandle: { stop: () => void } | undefined;
  let activeSocket: WebSocket | undefined;

  afterEach(() => {
    activeSocket?.close();
    activeSocket = undefined;
    activeHandle?.stop();
    activeHandle = undefined;
  });

  test("a device.capabilities message updates DeviceRegistry's stored permission status", async () => {
    const { handle, port, deviceRegistry } = setupServer();
    activeHandle = handle;

    const deviceId = "capabilities-device-1";
    const ws = await registerAndApprove(port!, deviceId);
    activeSocket = ws;

    ws.send(
      JSON.stringify({
        requestId: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        deviceId,
        type: "device.capabilities",
        payload: { permissions: { accessibility: "granted", microphone: "denied", notifications: "granted" } },
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(deviceRegistry.getDevice(deviceId)?.permissions).toEqual({
      accessibility: "granted",
      microphone: "denied",
      notifications: "granted",
    });
  });

  test("a malformed device.capabilities message is rejected without crashing the connection", async () => {
    const { handle, port, deviceRegistry } = setupServer();
    activeHandle = handle;

    const deviceId = "capabilities-device-2";
    const ws = await registerAndApprove(port!, deviceId);
    activeSocket = ws;

    const errors: unknown[] = [];
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data as string);
      if (message.type === "error") errors.push(message);
    };

    ws.send(
      JSON.stringify({
        requestId: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        deviceId,
        type: "device.capabilities",
        payload: { permissions: { accessibility: "maybe" } },
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(errors.length).toBeGreaterThan(0);
    expect(deviceRegistry.getDevice(deviceId)?.permissions).toBeNull();

    // The connection itself must still be usable after a rejected message.
    ws.send(
      JSON.stringify({
        requestId: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        deviceId,
        type: "device.capabilities",
        payload: { permissions: { accessibility: "granted" } },
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(deviceRegistry.getDevice(deviceId)?.permissions).toEqual({ accessibility: "granted" });
  });

  test("a device.capabilities message for an unregistered deviceId is ignored, not an error", async () => {
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
        type: "device.capabilities",
        payload: { permissions: { accessibility: "granted" } },
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(errors).toHaveLength(0);
  });
});
