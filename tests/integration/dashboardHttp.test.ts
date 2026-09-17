import { describe, test, expect, afterEach } from "bun:test";
import { EventBus } from "@/core/events/EventBus";
import { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import { PairingService } from "@/devices/pairing/PairingService";
import { DeviceConnectionManager } from "@/communication/websocket/DeviceConnectionManager";
import { JarvisWebSocketServer } from "@/communication/websocket/JarvisWebSocketServer";
import { ToolRegistry } from "@/tools/registry/ToolRegistry";
import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";

function makeTool(id: string): LocalTool {
  return {
    id,
    name: id.toLowerCase(),
    description: "A test tool",
    inputSchema: { type: "object", properties: {} },
    requiredPermission: PermissionLevel.READ,
    target: "local",
    execute: async () => ({ success: true }),
  };
}

describe("Dashboard HTTP routes", () => {
  let activeHandle: { stop: () => void } | undefined;

  afterEach(() => {
    activeHandle?.stop();
    activeHandle = undefined;
  });

  test("GET / serves the dashboard HTML", async () => {
    const eventBus = new EventBus();
    const server = new JarvisWebSocketServer({
      deviceRegistry: new DeviceRegistry(),
      deviceConnectionManager: new DeviceConnectionManager(eventBus),
      pairingService: new PairingService(),
      eventBus,
    });
    const handle = server.start(0);
    activeHandle = handle;

    const response = await fetch(`http://localhost:${handle.port}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html");
    const body = await response.text();
    expect(body).toContain("JARVIS");
    expect(body).toContain("/status");
  });

  test("GET /dashboard serves the same page as GET /", async () => {
    const eventBus = new EventBus();
    const server = new JarvisWebSocketServer({
      deviceRegistry: new DeviceRegistry(),
      deviceConnectionManager: new DeviceConnectionManager(eventBus),
      pairingService: new PairingService(),
      eventBus,
    });
    const handle = server.start(0);
    activeHandle = handle;

    const response = await fetch(`http://localhost:${handle.port}/dashboard`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html");
  });

  test("GET /status reports registered devices, tools, and phone gateway state", async () => {
    const eventBus = new EventBus();
    const deviceRegistry = new DeviceRegistry();
    deviceRegistry.registerDevice({
      id: "imac-1",
      name: "Office iMac",
      type: "mac",
      platform: "macos",
      agentVersion: "0.1.0",
      protocolVersion: "1",
    });
    deviceRegistry.setRole("imac-1", "primary");
    deviceRegistry.updateStatus("imac-1", "online");

    const toolRegistry = new ToolRegistry();
    toolRegistry.registerTool(makeTool("SAVE_MEMORY"));

    const server = new JarvisWebSocketServer({
      deviceRegistry,
      deviceConnectionManager: new DeviceConnectionManager(eventBus),
      pairingService: new PairingService(),
      eventBus,
      toolRegistry,
    });
    const handle = server.start(0);
    activeHandle = handle;

    const response = await fetch(`http://localhost:${handle.port}/status`);
    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      devices: unknown[];
      tools: unknown[];
      phoneGatewayEnabled: boolean;
    };

    expect(data.devices).toEqual([
      expect.objectContaining({ id: "imac-1", name: "Office iMac", role: "primary", status: "online" }),
    ]);
    expect(data.tools).toEqual([{ name: "save_memory", target: "local" }]);
    expect(data.phoneGatewayEnabled).toBe(false);
  });

  test("GET /status reflects an enabled phone gateway", async () => {
    const eventBus = new EventBus();
    const server = new JarvisWebSocketServer({
      deviceRegistry: new DeviceRegistry(),
      deviceConnectionManager: new DeviceConnectionManager(eventBus),
      pairingService: new PairingService(),
      eventBus,
      phoneGateway: {} as never, // presence alone is what /status reports on
    });
    const handle = server.start(0);
    activeHandle = handle;

    const response = await fetch(`http://localhost:${handle.port}/status`);
    const data = (await response.json()) as { phoneGatewayEnabled: boolean };
    expect(data.phoneGatewayEnabled).toBe(true);
  });

  test("a WebSocket upgrade request to \"/\" still connects instead of getting the HTML page", async () => {
    const eventBus = new EventBus();
    const server = new JarvisWebSocketServer({
      deviceRegistry: new DeviceRegistry(),
      deviceConnectionManager: new DeviceConnectionManager(eventBus),
      pairingService: new PairingService(),
      eventBus,
    });
    const handle = server.start(0);
    activeHandle = handle;

    const opened = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://localhost:${handle.port}/`);
      ws.onopen = () => {
        ws.close();
        resolve(true);
      };
      ws.onerror = () => resolve(false);
    });

    expect(opened).toBe(true);
  });
});
