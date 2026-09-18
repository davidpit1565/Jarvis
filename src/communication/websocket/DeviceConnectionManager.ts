import { randomUUID } from "node:crypto";
import type { EventBus } from "@/core/events/EventBus";
import type { ToolResult } from "@/types/tools";
import { makeEnvelope, type ToolResultMessage } from "./protocol";

const DEFAULT_TOOL_TIMEOUT_MS = 10_000;

/** Transport-agnostic connection abstraction so this class never touches a raw WebSocket. */
export interface DeviceConnection {
  send(raw: string): void;
  /** Optional: actually closes the underlying transport (e.g. on revocation), not just stops routing to it. */
  close?(): void;
}

interface PendingToolRequest {
  deviceId: string;
  resolve: (result: ToolResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * Owns active device connections and the request/response lifecycle for
 * device-executed tools. The Orchestrator talks to this, never to a raw
 * WebSocket — that's what makes adding iPhone/MacBook later a matter of
 * connecting a new `DeviceConnection`, not touching the Orchestrator.
 */
export class DeviceConnectionManager {
  private connections: Map<string, DeviceConnection> = new Map();
  private pending: Map<string, PendingToolRequest> = new Map();

  constructor(
    private readonly eventBus: EventBus,
    private readonly toolTimeoutMs: number = DEFAULT_TOOL_TIMEOUT_MS
  ) {}

  registerConnection(deviceId: string, connection: DeviceConnection): void {
    this.connections.set(deviceId, connection);
    this.eventBus.emit("device.connected", { deviceId });
  }

  removeConnection(deviceId: string, reason: string = "disconnected"): void {
    const connection = this.connections.get(deviceId);
    const had = this.connections.delete(deviceId);
    this.rejectAllPendingForDevice(deviceId, new Error(`Device disconnected: ${deviceId}`));
    if (had) {
      connection?.close?.();
      this.eventBus.emit("device.disconnected", { deviceId, reason });
    }
  }

  hasConnection(deviceId: string): boolean {
    return this.connections.has(deviceId);
  }

  /**
   * Sends a "ping" to every connected device — paired with the server's
   * own WebSocket `idleTimeout`, this is what keeps a genuinely healthy
   * but quiet connection (no tool calls in a while) from being closed as
   * idle: the Agent's real "pong" reply (see `main.swift`'s existing
   * handler for it) is itself socket activity, resetting the timeout.
   * A connection that's actually dead just never replies and gets
   * cleaned up by the idle timeout as intended.
   */
  pingAll(): void {
    for (const [deviceId, connection] of this.connections) {
      connection.send(JSON.stringify(makeEnvelope("ping", {}, deviceId, randomUUID())));
    }
  }

  /** Sends a raw envelope to a device without expecting a correlated response. */
  send(deviceId: string, raw: string): void {
    const connection = this.connections.get(deviceId);
    if (!connection) {
      throw new Error(`Unknown device connection: ${deviceId}`);
    }
    connection.send(raw);
  }

  /**
   * Dispatches a tool.request to a device and resolves once a matching
   * tool.result arrives, the request times out, or the device disconnects.
   */
  sendToolRequest(deviceId: string, tool: string, input: Record<string, unknown>): Promise<ToolResult> {
    const connection = this.connections.get(deviceId);
    if (!connection) {
      return Promise.reject(new Error(`Unknown device: ${deviceId}`));
    }

    const requestId = randomUUID();
    const envelope = makeEnvelope("tool.request", { tool, input }, deviceId, requestId);

    return new Promise<ToolResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Tool request timed out after ${this.toolTimeoutMs}ms: ${tool} on ${deviceId}`));
      }, this.toolTimeoutMs);

      this.pending.set(requestId, { deviceId, resolve, reject, timeout });
      this.eventBus.emit("tool.dispatched", { toolName: tool, deviceId, requestId });

      try {
        connection.send(JSON.stringify(envelope));
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error("Failed to send tool request"));
      }
    });
  }

  /**
   * Feeds a device's tool.result back into the matching pending request.
   * A requestId with no pending entry (stale, duplicate, or already timed
   * out) and a requestId whose device doesn't match the original request
   * are both ignored rather than throwing — a malformed or spoofed result
   * must never resolve someone else's promise.
   */
  handleToolResult(message: ToolResultMessage): void {
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    if (pending.deviceId !== message.deviceId) return;

    clearTimeout(pending.timeout);
    this.pending.delete(message.requestId);
    pending.resolve({
      success: message.payload.success,
      data: message.payload.data,
      error: message.payload.error,
    });
  }

  handleDisconnect(deviceId: string, reason: string = "disconnected"): void {
    this.removeConnection(deviceId, reason);
  }

  private rejectAllPendingForDevice(deviceId: string, error: Error): void {
    for (const [requestId, pending] of this.pending.entries()) {
      if (pending.deviceId === deviceId) {
        clearTimeout(pending.timeout);
        pending.reject(error);
        this.pending.delete(requestId);
      }
    }
  }
}
