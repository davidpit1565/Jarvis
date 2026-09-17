import type { ServerWebSocket } from "bun";
import { randomUUID } from "node:crypto";
import type { EventBus } from "@/core/events/EventBus";
import type { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import type { PairingService } from "@/devices/pairing/PairingService";
import { DeviceConnectionManager } from "./DeviceConnectionManager";
import {
  makeEnvelope,
  parseDeviceToCoreMessage,
  type DeviceRegisterMessage,
  type ToolResultMessage,
} from "./protocol";

interface SocketData {
  deviceId: string | null;
}

export interface JarvisWebSocketServerDependencies {
  deviceRegistry: DeviceRegistry;
  deviceConnectionManager: DeviceConnectionManager;
  pairingService: PairingService;
  eventBus: EventBus;
}

/**
 * WebSocket transport for Core <-> device agents. Deliberately thin: all
 * routing/lifecycle decisions live in DeviceConnectionManager, DeviceRegistry,
 * and PairingService — this class only turns bytes into validated protocol
 * messages and back.
 */
export class JarvisWebSocketServer {
  /** Sockets that have sent device.register but aren't authenticated yet, keyed by deviceId. */
  private pendingConnections: Map<string, ServerWebSocket<SocketData>> = new Map();

  constructor(private readonly deps: JarvisWebSocketServerDependencies) {}

  start(port: number) {
    return Bun.serve<SocketData>({
      port,
      fetch: async (req, server) => {
        const url = new URL(req.url);

        if (req.method === "POST" && url.pathname === "/pairing/approve") {
          return this.handleApproveHttp(req);
        }

        if (server.upgrade(req, { data: { deviceId: null } })) {
          return undefined;
        }
        return new Response("JARVIS Core WebSocket endpoint", { status: 200 });
      },
      websocket: {
        open: () => {
          // No-op: a connection is only meaningful once it registers.
        },
        message: (ws, raw) => {
          this.handleMessage(ws as ServerWebSocket<SocketData>, raw.toString());
        },
        close: (ws) => {
          const deviceId = (ws as ServerWebSocket<SocketData>).data.deviceId;
          if (deviceId) {
            this.pendingConnections.delete(deviceId);
            this.deps.deviceConnectionManager.handleDisconnect(deviceId, "socket_closed");
            this.deps.deviceRegistry.updateStatus(deviceId, "offline");
          }
        },
      },
    });
  }

  private handleMessage(ws: ServerWebSocket<SocketData>, raw: string): void {
    const result = parseDeviceToCoreMessage(raw);

    if (!result.ok) {
      ws.send(JSON.stringify({ type: "error", reason: result.reason }));
      return;
    }

    const message = result.message;

    switch (message.type) {
      case "device.register":
        this.handleRegister(ws, message);
        return;
      case "tool.result":
        this.deps.deviceConnectionManager.handleToolResult(message as ToolResultMessage);
        return;
      case "device.status":
        if (message.deviceId) {
          this.deps.deviceRegistry.updateStatus(message.deviceId, message.payload.status);
        }
        return;
      case "pong":
      case "event":
        // Heartbeats and generic device events aren't acted on in Phase 2.
        return;
    }
  }

  private handleRegister(ws: ServerWebSocket<SocketData>, message: DeviceRegisterMessage): void {
    const { deviceRegistry, pairingService, deviceConnectionManager } = this.deps;
    const payload = message.payload;

    const deviceId = message.deviceId ?? randomUUID();
    const existingDevice = deviceRegistry.getDevice(deviceId);

    if (!existingDevice) {
      deviceRegistry.registerDevice({
        id: deviceId,
        name: payload.deviceName,
        type: payload.deviceType,
        platform: payload.platform,
        agentVersion: payload.agentVersion,
        protocolVersion: payload.protocolVersion,
        capabilities: payload.capabilities,
        requestedRole: payload.requestedRole,
      });
      this.deps.eventBus.emit("device.registered", { device: deviceRegistry.getDevice(deviceId)! });
    }

    const isAuthenticated = payload.credential
      ? pairingService.verifyCredential(deviceId, payload.credential)
      : false;

    if (!isAuthenticated) {
      const pairing = pairingService.requestPairing(deviceId);
      // Tracked as "known but not yet trusted" — deviceConnectionManager
      // (the authenticated set) only learns about this socket once approved.
      ws.data.deviceId = deviceId;
      this.pendingConnections.set(deviceId, ws);
      this.send(ws, deviceId, "device.command", {
        command: "pairing.pending",
        args: { code: pairing.code, expiresAt: pairing.expiresAt },
      });
      return;
    }

    this.pendingConnections.delete(deviceId);
    ws.data.deviceId = deviceId;
    deviceConnectionManager.registerConnection(deviceId, { send: (data) => ws.send(data) });
    deviceRegistry.updateStatus(deviceId, "online");
    this.send(ws, deviceId, "device.command", { command: "pairing.approved" });
  }

  /**
   * Approves a device's pending pairing code, mints its long-lived
   * credential via PairingService, and — if the device's socket is still
   * open and waiting — pushes the credential to it immediately and
   * promotes the connection to authenticated. This is the only place a
   * device transitions from "registered metadata" to "trusted connection".
   */
  approveDevice(deviceId: string, code: string): { credential: string } {
    const { pairingService, deviceConnectionManager, deviceRegistry } = this.deps;
    const { secret } = pairingService.approvePairing(deviceId, code);

    const ws = this.pendingConnections.get(deviceId);
    if (ws) {
      this.pendingConnections.delete(deviceId);
      ws.data.deviceId = deviceId;
      deviceConnectionManager.registerConnection(deviceId, { send: (data) => ws.send(data) });
      deviceRegistry.updateStatus(deviceId, "online");
      this.send(ws, deviceId, "device.command", {
        command: "pairing.approved",
        args: { credential: secret },
      });
    }

    return { credential: secret };
  }

  private async handleApproveHttp(req: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
    }

    if (
      typeof body !== "object" ||
      body === null ||
      typeof (body as Record<string, unknown>).deviceId !== "string" ||
      typeof (body as Record<string, unknown>).code !== "string"
    ) {
      return Response.json({ success: false, error: "Body must be { deviceId: string, code: string }" }, { status: 400 });
    }

    const { deviceId, code } = body as { deviceId: string; code: string };

    try {
      const result = this.approveDevice(deviceId, code);
      return Response.json({ success: true, deviceId, credentialIssued: Boolean(result.credential) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to approve pairing";
      return Response.json({ success: false, error: message }, { status: 400 });
    }
  }

  private send(
    ws: ServerWebSocket<SocketData>,
    deviceId: string,
    type: "device.command",
    payload: { command: string; args?: Record<string, unknown> }
  ): void {
    ws.send(JSON.stringify(makeEnvelope(type, payload, deviceId, randomUUID())));
  }
}
