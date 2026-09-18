import { describe, test, expect, afterEach } from "bun:test";
import { EventBus } from "@/core/events/EventBus";
import { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import { PairingService } from "@/devices/pairing/PairingService";
import { ToolRegistry } from "@/tools/registry/ToolRegistry";
import { DeviceConnectionManager } from "@/communication/websocket/DeviceConnectionManager";
import { JarvisWebSocketServer } from "@/communication/websocket/JarvisWebSocketServer";
import { readOnlyFileInfoTool } from "@/tools/filesystem/ReadOnlyFileInfoTool";
import { getActiveApplicationTool } from "@/tools/system/GetActiveApplicationTool";

interface StatusResponseBody {
  devices: Array<{ id: string; name: string; status: string }>;
  tools: Array<{ name: string; target: string }>;
  observers: number;
}

/**
 * GET /status is the one real status feed both the dashboard and the
 * hologram UI poll — this proves it reports Core's actual registered
 * state, not a fixture, and that the hologram's own /observer count is
 * folded into that same shared shape rather than a second endpoint.
 */
function setupServer() {
  const eventBus = new EventBus();
  const deviceRegistry = new DeviceRegistry();
  const pairingService = new PairingService();
  const toolRegistry = new ToolRegistry();
  toolRegistry.registerTool(readOnlyFileInfoTool);
  toolRegistry.registerTool(getActiveApplicationTool);
  const deviceConnectionManager = new DeviceConnectionManager(eventBus);
  const server = new JarvisWebSocketServer({
    deviceRegistry,
    deviceConnectionManager,
    pairingService,
    eventBus,
    toolRegistry,
  });
  const handle = server.start(0);
  return { handle, port: handle.port, deviceRegistry };
}

describe("GET /status", () => {
  let activeHandle: { stop: () => void } | undefined;

  afterEach(() => {
    activeHandle?.stop();
    activeHandle = undefined;
  });

  test("reports the real registered tool list and zero devices when none are registered", async () => {
    const { handle, port } = setupServer();
    activeHandle = handle;

    const res = await fetch(`http://localhost:${port}/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as StatusResponseBody;

    expect(body.devices).toEqual([]);
    expect(body.tools.map((t) => t.name).sort()).toEqual(["get_active_application", "read_only_file_info"].sort());
    expect(body.observers).toBe(0);
    // The hologram UI fetches this from a file:// page — without this
    // header the browser blocks reading the response even though the
    // request succeeds server-side.
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("reflects a registered device's online count after status updates", async () => {
    const { handle, port, deviceRegistry } = setupServer();
    activeHandle = handle;

    deviceRegistry.registerDevice({
      id: "device-1",
      name: "Test iMac",
      type: "mac",
      platform: "macos",
      agentVersion: "0.1.0",
      protocolVersion: "1",
      capabilities: [],
    });
    deviceRegistry.updateStatus("device-1", "online");

    const res = await fetch(`http://localhost:${port}/status`);
    const body = (await res.json()) as StatusResponseBody;

    expect(body.devices).toHaveLength(1);
    expect(body.devices[0]?.status).toBe("online");
  });

  test("counts a connected /observer socket", async () => {
    const { handle, port } = setupServer();
    activeHandle = handle;

    const ws = new WebSocket(`ws://localhost:${port}/observer`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("observer socket failed to open"));
      setTimeout(() => reject(new Error("Timed out opening observer socket")), 2000);
    });

    const res = await fetch(`http://localhost:${port}/status`);
    const body = (await res.json()) as StatusResponseBody;
    expect(body.observers).toBe(1);

    ws.close();
  });
});
