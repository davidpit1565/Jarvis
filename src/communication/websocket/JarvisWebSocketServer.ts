import type { ServerWebSocket } from "bun";
import { parseClientMessage, type CoreToClientMessage } from "./protocol";

interface SocketData {
  deviceId: string | null;
}

/**
 * Minimal WebSocket server establishing the Core <-> device communication
 * contract. No real device connects yet; this only proves the transport
 * and message protocol work end to end.
 */
export class JarvisWebSocketServer {
  private connections: Map<ServerWebSocket<SocketData>, SocketData> = new Map();

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
        open: (ws) => {
          this.connections.set(ws, ws.data);
        },
        message: (ws, raw) => {
          const message = parseClientMessage(raw.toString());
          if (!message) {
            ws.send(JSON.stringify({ type: "error", reason: "Unrecognized message format" }));
            return;
          }
          if (message.type === "command") {
            ws.data.deviceId = message.deviceId;
          }
          // Phase 1 only validates and echoes acknowledgement; the
          // orchestrator is not yet wired to dispatch tool_request
          // messages to real devices.
          ws.send(JSON.stringify({ type: "ack", received: message.type }));
        },
        close: (ws) => {
          this.connections.delete(ws);
        },
      },
    });
  }

  sendToolRequest(ws: ServerWebSocket<SocketData>, message: CoreToClientMessage): void {
    ws.send(JSON.stringify(message));
  }
}
