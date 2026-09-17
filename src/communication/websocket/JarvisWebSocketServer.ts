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
  constructor(private readonly deps: JarvisWebSocketServerDependencies) {}

  start(port: number) {
    return Bun.serve<SocketData>({
      port,
      fetch: (req, server) => {
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
      ws.data.deviceId = null;
      this.send(ws, deviceId, "device.command", {
        command: "pairing.pending",
        args: { code: pairing.code, expiresAt: pairing.expiresAt },
      });
      return;
    }

    ws.data.deviceId = deviceId;
    deviceConnectionManager.registerConnection(deviceId, { send: (data) => ws.send(data) });
    deviceRegistry.updateStatus(deviceId, "online");
    this.send(ws, deviceId, "device.command", { command: "pairing.approved" });
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
