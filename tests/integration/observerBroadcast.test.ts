import { describe, test, expect, afterEach } from "bun:test";
import { EventBus } from "@/core/events/EventBus";
import { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import { PairingService } from "@/devices/pairing/PairingService";
import { DeviceConnectionManager } from "@/communication/websocket/DeviceConnectionManager";
import { JarvisWebSocketServer } from "@/communication/websocket/JarvisWebSocketServer";

/**
 * Exercises the real `/observer` endpoint end to end: a spectator socket
 * (e.g. the hologram UI) connects with no device-register handshake, and
 * confirms that a real EventBus event gets mirrored to it verbatim. This
 * is the mechanism `ui/hologram/index.html`'s "CORE ACTIVITY" panel relies
 * on for its live (non-demo) feed.
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
  });
  const handle = server.start(0); // port 0: let the OS pick a free port
  return { handle, port: handle.port, eventBus };
}

describe("Observer broadcast (/observer)", () => {
  let activeHandle: { stop: () => void } | undefined;

  afterEach(() => {
    activeHandle?.stop();
    activeHandle = undefined;
  });

  test("mirrors a real EventBus event to a connected observer with no registration required", async () => {
    const { handle, port, eventBus } = setupServer();
    activeHandle = handle;

    const ws = new WebSocket(`ws://localhost:${port}/observer`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("observer socket failed to open"));
      setTimeout(() => reject(new Error("Timed out opening observer socket")), 2000);
    });

    const received = new Promise<{ type: string; payload: unknown; timestamp: string }>((resolve, reject) => {
      ws.onmessage = (event) => resolve(JSON.parse(event.data as string));
      setTimeout(() => reject(new Error("Timed out waiting for broadcast")), 2000);
    });

    eventBus.emit("tool.executed", {
      toolName: "getActiveApplication",
      requestId: "req-123",
      result: { success: true, data: { app: "Safari" } },
      userId: "local-user",
      input: {},
      toolCallId: "req-123",
    });

    const message = await received;
    expect(message.type).toBe("tool.executed");
    expect(message.payload).toEqual({
      toolName: "getActiveApplication",
      requestId: "req-123",
      result: { success: true, data: { app: "Safari" } },
      userId: "local-user",
      input: {},
      toolCallId: "req-123",
    });
    expect(typeof message.timestamp).toBe("string");

    ws.close();
  });

  test("an observer sending data is ignored, not treated as a device message", async () => {
    const { handle, port, eventBus } = setupServer();
    activeHandle = handle;

    const ws = new WebSocket(`ws://localhost:${port}/observer`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("observer socket failed to open"));
      setTimeout(() => reject(new Error("Timed out opening observer socket")), 2000);
    });

    // Send something that would be rejected/error'd if routed through the
    // device protocol parser — the server must silently ignore it instead.
    ws.send("not a valid envelope");

    // Prove the server is still alive and still broadcasting afterward.
    const received = new Promise<{ type: string }>((resolve, reject) => {
      ws.onmessage = (event) => resolve(JSON.parse(event.data as string));
      setTimeout(() => reject(new Error("Timed out waiting for broadcast")), 2000);
    });
    eventBus.emit("device.connected", { deviceId: "still-alive" });

    const message = await received;
    expect(message.type).toBe("device.connected");

    ws.close();
  });

  test("does not broadcast to a device socket that never connected on /observer", async () => {
    const { handle, port, eventBus } = setupServer();
    activeHandle = handle;

    const deviceWs = new WebSocket(`ws://localhost:${port}`); // note: no /observer path
    const messages: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      deviceWs.onopen = () => resolve();
      deviceWs.onerror = () => reject(new Error("device socket failed to open"));
      setTimeout(() => reject(new Error("Timed out opening device socket")), 2000);
    });
    deviceWs.onmessage = (event) => messages.push(JSON.parse(event.data as string));

    eventBus.emit("brain.request", { messageCount: 1 });

    // Give the (non-)broadcast a moment, then confirm nothing arrived —
    // an un-registered, non-observer socket must never see Core's events.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(messages.length).toBe(0);

    deviceWs.close();
  });

  test("mirrors jarvis.liveState.changed to a connected observer (roadmap items 92-97/101-103, UI half of item 36)", async () => {
    const { handle, port, eventBus } = setupServer();
    activeHandle = handle;

    const ws = new WebSocket(`ws://localhost:${port}/observer`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("observer socket failed to open"));
      setTimeout(() => reject(new Error("Timed out opening observer socket")), 2000);
    });

    const received = new Promise<{ type: string; payload: unknown }>((resolve, reject) => {
      ws.onmessage = (event) => resolve(JSON.parse(event.data as string));
      setTimeout(() => reject(new Error("Timed out waiting for broadcast")), 2000);
    });

    eventBus.emit("jarvis.liveState.changed", {
      sessionId: "chat:user-1",
      userId: "user-1",
      from: "IDLE",
      to: "LISTENING",
      reason: "user message received",
      timestamp: Date.now(),
    });

    const message = await received;
    expect(message.type).toBe("jarvis.liveState.changed");
    expect(message.payload).toMatchObject({
      sessionId: "chat:user-1",
      userId: "user-1",
      from: "IDLE",
      to: "LISTENING",
    });

    ws.close();
  });

  test("rejects an /observer upgrade with no token when an admin token is configured", async () => {
    const { handle, port } = setupServer("secret-token");
    activeHandle = handle;

    const res = await fetch(`http://localhost:${port}/observer`, {
      headers: { Upgrade: "websocket", Connection: "Upgrade" },
    });
    expect(res.status).toBe(401);
  });

  test("accepts an /observer upgrade with the correct token when one is configured", async () => {
    const { handle, port, eventBus } = setupServer("secret-token");
    activeHandle = handle;

    const ws = new WebSocket(`ws://localhost:${port}/observer?token=secret-token`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("observer socket failed to open"));
      setTimeout(() => reject(new Error("Timed out opening observer socket")), 2000);
    });

    const received = new Promise<{ type: string }>((resolve, reject) => {
      ws.onmessage = (event) => resolve(JSON.parse(event.data as string));
      setTimeout(() => reject(new Error("Timed out waiting for broadcast")), 2000);
    });
    eventBus.emit("device.connected", { deviceId: "authed-observer" });

    const message = await received;
    expect(message.type).toBe("device.connected");

    ws.close();
  });
});
