import { describe, test, expect, afterEach } from "bun:test";
import { EventBus } from "@/core/events/EventBus";
import { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import { PairingService } from "@/devices/pairing/PairingService";
import { DeviceConnectionManager } from "@/communication/websocket/DeviceConnectionManager";
import { JarvisWebSocketServer } from "@/communication/websocket/JarvisWebSocketServer";
import { LockdownService } from "@/core/lockdown/LockdownService";

function setupServer(adminToken?: string, lockdownService: LockdownService = new LockdownService()) {
  const eventBus = new EventBus();
  const server = new JarvisWebSocketServer({
    deviceRegistry: new DeviceRegistry(),
    deviceConnectionManager: new DeviceConnectionManager(eventBus),
    pairingService: new PairingService(),
    eventBus,
    lockdownService,
    adminToken,
  });
  const handle = server.start(0);
  return { handle, port: handle.port, lockdownService };
}

describe("Emergency lockdown HTTP routes", () => {
  let activeHandle: { stop: () => void } | undefined;

  afterEach(() => {
    activeHandle?.stop();
    activeHandle = undefined;
  });

  test("activates lockdown and reflects it in the response", async () => {
    const { handle, port, lockdownService } = setupServer();
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/emergency/lockdown`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "phone lost" }),
    });
    const body = (await response.json()) as { success: boolean; status: { active: boolean; reason: string } };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.status.active).toBe(true);
    expect(body.status.reason).toBe("phone lost");
    expect(lockdownService.isActive()).toBe(true);
  });

  test("activates lockdown with no body at all", async () => {
    const { handle, port } = setupServer();
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/emergency/lockdown`, { method: "POST" });
    expect(response.status).toBe(200);
  });

  test("lifts an active lockdown", async () => {
    const lockdownService = new LockdownService();
    lockdownService.activate("test");
    const { handle, port } = setupServer(undefined, lockdownService);
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/emergency/lockdown/lift`, { method: "POST" });
    const body = (await response.json()) as { success: boolean; status: { active: boolean } };

    expect(response.status).toBe(200);
    expect(body.status.active).toBe(false);
    expect(lockdownService.isActive()).toBe(false);
  });

  test("requires the admin token when one is configured", async () => {
    const { handle, port } = setupServer("correct-admin-secret");
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/emergency/lockdown`, { method: "POST" });
    expect(response.status).toBe(401);
  });

  test("succeeds with the correct admin token", async () => {
    const { handle, port, lockdownService } = setupServer("correct-admin-secret");
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/emergency/lockdown`, {
      method: "POST",
      headers: { "X-Jarvis-Admin-Token": "correct-admin-secret" },
    });

    expect(response.status).toBe(200);
    expect(lockdownService.isActive()).toBe(true);
  });

  test("404s when no lockdown service is configured", async () => {
    const eventBus = new EventBus();
    const server = new JarvisWebSocketServer({
      deviceRegistry: new DeviceRegistry(),
      deviceConnectionManager: new DeviceConnectionManager(eventBus),
      pairingService: new PairingService(),
      eventBus,
      // no lockdownService
    });
    const handle = server.start(0);
    activeHandle = handle;

    const response = await fetch(`http://localhost:${handle.port}/emergency/lockdown`, { method: "POST" });
    expect(response.status).toBe(404);
  });

  test("GET /status reflects lockdown state", async () => {
    const lockdownService = new LockdownService();
    lockdownService.activate("test reason");
    const { handle, port } = setupServer(undefined, lockdownService);
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/status`);
    const body = (await response.json()) as { lockdown: { active: boolean; reason: string } };

    expect(body.lockdown.active).toBe(true);
    expect(body.lockdown.reason).toBe("test reason");
  });
});
