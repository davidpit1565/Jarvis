import { describe, test, expect, afterEach } from "bun:test";
import { EventBus } from "@/core/events/EventBus";
import { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import { PairingService } from "@/devices/pairing/PairingService";
import { DeviceConnectionManager } from "@/communication/websocket/DeviceConnectionManager";
import { JarvisWebSocketServer } from "@/communication/websocket/JarvisWebSocketServer";
import { PermissionService } from "@/permissions/PermissionService";
import { PermissionLevel } from "@/types/permissions";

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

  test("approving a device that requested primary actually grants it the role", async () => {
    const { handle, port, deviceRegistry } = setupServer();
    activeHandle = handle;

    const deviceId = "test-imac-primary";
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
        if (message.payload?.command === "pairing.pending") resolve(message.payload.args.code);
      };
      ws.onerror = () => reject(new Error("WebSocket error"));
      setTimeout(() => reject(new Error("Timed out waiting for pairing.pending")), 2000);
    });

    expect(deviceRegistry.getDevice(deviceId)?.role).toBeNull();

    const httpResponse = await fetch(`http://localhost:${port}/pairing/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId, code: pairingCode }),
    });
    expect(httpResponse.status).toBe(200);

    expect(deviceRegistry.getDevice(deviceId)?.role).toBe("primary");
    expect(deviceRegistry.getPrimaryDevice()?.id).toBe(deviceId);

    ws.close();
  });

  test("approving a device grants it exactly the configured tool list, scoped to that device only", () => {
    // Direct user decision: broader "control the computer" tools are
    // wanted, but must never be usable until the human has explicitly
    // trusted a specific device — approving its pairing (this test's
    // whole subject) is that one explicit moment in this system.
    const eventBus = new EventBus();
    const deviceRegistry = new DeviceRegistry();
    const pairingService = new PairingService();
    const deviceConnectionManager = new DeviceConnectionManager(eventBus);
    const permissionService = new PermissionService();
    const deviceId = "test-imac-grant";
    const userId = "local-user";

    deviceRegistry.registerDevice({
      id: deviceId,
      name: "Test iMac",
      type: "mac",
      platform: "macos",
      agentVersion: "0.1.0",
      protocolVersion: "1",
      capabilities: [],
    });
    const pairing = pairingService.requestPairing(deviceId);

    const server = new JarvisWebSocketServer({
      deviceRegistry,
      deviceConnectionManager,
      pairingService,
      eventBus,
      permissionService,
      defaultUserId: userId,
      autoGrantToolIdsOnApproval: ["OPEN_URL", "CLICK_ELEMENT"],
    });

    server.approveDevice(deviceId, pairing.code);

    const openUrl = permissionService.check({
      subject: { userId },
      toolId: "OPEN_URL",
      requiredLevel: PermissionLevel.SAFE_ACTION,
      deviceId,
    });
    expect(openUrl.allowed).toBe(true);
    expect(openUrl.requiresConfirmation).toBe(false);

    const clickElement = permissionService.check({
      subject: { userId },
      toolId: "CLICK_ELEMENT",
      requiredLevel: PermissionLevel.CONFIRM,
      deviceId,
    });
    expect(clickElement.allowed).toBe(true);
    // A grant is never enough on its own for CONFIRM — real-time human
    // approval is still required for every single invocation.
    expect(clickElement.requiresConfirmation).toBe(true);

    // Not in the auto-grant list — approving the device must not
    // silently grant every device tool that exists.
    const typeText = permissionService.check({
      subject: { userId },
      toolId: "TYPE_TEXT",
      requiredLevel: PermissionLevel.CONFIRM,
      deviceId,
    });
    expect(typeText.allowed).toBe(false);

    // Scoped to this device only — never leaks to a different one.
    const wrongDevice = permissionService.check({
      subject: { userId },
      toolId: "OPEN_URL",
      requiredLevel: PermissionLevel.SAFE_ACTION,
      deviceId: "some-other-device",
    });
    expect(wrongDevice.allowed).toBe(false);
  });

  test("approving a second device that requested primary does not steal the role, and approval still succeeds", async () => {
    const { handle, port, deviceRegistry } = setupServer();
    activeHandle = handle;

    deviceRegistry.registerDevice({
      id: "already-primary",
      name: "Existing Primary",
      type: "mac",
      platform: "macos",
      agentVersion: "0.1.0",
      protocolVersion: "1",
    });
    deviceRegistry.setRole("already-primary", "primary");

    const deviceId = "second-device";
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
              deviceName: "Second Device",
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
        if (message.payload?.command === "pairing.pending") resolve(message.payload.args.code);
      };
      ws.onerror = () => reject(new Error("WebSocket error"));
      setTimeout(() => reject(new Error("Timed out waiting for pairing.pending")), 2000);
    });

    const httpResponse = await fetch(`http://localhost:${port}/pairing/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId, code: pairingCode }),
    });

    // Approval itself must still succeed even though the role grant is skipped.
    expect(httpResponse.status).toBe(200);
    expect(deviceRegistry.getDevice(deviceId)?.role).toBeNull();
    expect(deviceRegistry.getPrimaryDevice()?.id).toBe("already-primary");

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

describe("Pairing approval with an admin token configured", () => {
  let activeHandle: { stop: () => void } | undefined;

  afterEach(() => {
    activeHandle?.stop();
    activeHandle = undefined;
  });

  function setupServerWithAdminToken(adminToken: string) {
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
    return { handle, port: handle.port };
  }

  /**
   * Regression test for the self-approval bypass: without an admin token,
   * anything that can register a device and read its own pairing code
   * back over the socket can immediately approve itself. With one
   * configured, knowing the code is no longer sufficient.
   */
  test("an attacker who registers their own device and reads its pairing code still cannot self-approve without the admin token", async () => {
    const { handle, port } = setupServerWithAdminToken("correct-admin-secret");
    activeHandle = handle;

    const deviceId = "attacker-device";
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
              deviceName: "Attacker's fake device",
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
        if (message.payload?.command === "pairing.pending") resolve(message.payload.args.code);
      };
      ws.onerror = () => reject(new Error("WebSocket error"));
      setTimeout(() => reject(new Error("Timed out waiting for pairing.pending")), 2000);
    });

    // The attacker has the real, correct pairing code — but no admin token.
    const httpResponse = await fetch(`http://localhost:${port}/pairing/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId, code: pairingCode }),
    });
    const httpBody = (await httpResponse.json()) as { success: boolean };

    expect(httpResponse.status).toBe(401);
    expect(httpBody.success).toBe(false);

    ws.close();
  });

  test("rejects a request with the wrong admin token even if the pairing code is correct", async () => {
    const { handle, port } = setupServerWithAdminToken("correct-admin-secret");
    activeHandle = handle;

    const httpResponse = await fetch(`http://localhost:${port}/pairing/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Jarvis-Admin-Token": "wrong-token" },
      body: JSON.stringify({ deviceId: "some-device", code: "123456" }),
    });

    expect(httpResponse.status).toBe(401);
  });

  test("succeeds with the correct admin token", async () => {
    const { handle, port } = setupServerWithAdminToken("correct-admin-secret");
    activeHandle = handle;

    const deviceId = "legit-device";
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
              deviceName: "Legit device",
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

    const httpResponse = await fetch(`http://localhost:${port}/pairing/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Jarvis-Admin-Token": "correct-admin-secret" },
      body: JSON.stringify({ deviceId, code: pairingCode }),
    });
    const httpBody = (await httpResponse.json()) as { success: boolean };

    expect(httpResponse.status).toBe(200);
    expect(httpBody.success).toBe(true);

    ws.close();
  });
});
