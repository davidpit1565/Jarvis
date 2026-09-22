import { describe, test, expect, afterEach } from "bun:test";
import { EventBus } from "@/core/events/EventBus";
import { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import { PairingService } from "@/devices/pairing/PairingService";
import { DeviceConnectionManager } from "@/communication/websocket/DeviceConnectionManager";
import { JarvisWebSocketServer } from "@/communication/websocket/JarvisWebSocketServer";
import type { Orchestrator } from "@/core/orchestrator/Orchestrator";

/**
 * Exercises ws(s)://.../chat's streaming TTS support end to end: the
 * server should push each incremental `assistant_delta` frame as the
 * orchestrator's onTextDelta callback fires, followed by the existing
 * (unchanged) final `assistant` frame — additive to the protocol, never a
 * replacement for it.
 */
function setupStreamingServer() {
  const eventBus = new EventBus();
  const deviceRegistry = new DeviceRegistry();
  const pairingService = new PairingService();
  const deviceConnectionManager = new DeviceConnectionManager(eventBus);

  const webChatOrchestrator = {
    handleUserMessage: async (_userId: string, _content: string, _images: unknown, onTextDelta?: (text: string) => void) => {
      onTextDelta?.("Hel");
      onTextDelta?.("lo, ");
      onTextDelta?.("world.");
      return "Hello, world.";
    },
  } as unknown as Orchestrator;

  const server = new JarvisWebSocketServer({
    deviceRegistry,
    deviceConnectionManager,
    pairingService,
    eventBus,
    webChatOrchestrator,
  });
  const handle = server.start(0);
  return { handle, port: handle.port };
}

function connectAndCollect(port: number | undefined, payload: unknown, expectedFrameCount: number): Promise<{ ws: WebSocket; frames: Record<string, unknown>[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/chat`);
    const frames: Record<string, unknown>[] = [];
    ws.onopen = () => ws.send(JSON.stringify(payload));
    ws.onmessage = (event) => {
      frames.push(JSON.parse(event.data as string));
      if (frames.length >= expectedFrameCount) resolve({ ws, frames });
    };
    ws.onerror = () => reject(new Error("socket failed to open"));
    setTimeout(() => reject(new Error("Timed out waiting for frames")), 2000);
  });
}

describe("ws(s)://.../chat streaming TTS", () => {
  let activeHandle: { stop: () => void } | undefined;

  afterEach(() => {
    activeHandle?.stop();
    activeHandle = undefined;
  });

  test("pushes each assistant_delta as it's generated, then the final assistant frame", async () => {
    const { handle, port } = setupStreamingServer();
    activeHandle = handle;

    const { ws, frames } = await connectAndCollect(port, { text: "hi" }, 4);

    expect(frames).toEqual([
      { type: "assistant_delta", text: "Hel" },
      { type: "assistant_delta", text: "lo, " },
      { type: "assistant_delta", text: "world." },
      { type: "assistant", text: "Hello, world." },
    ]);
    ws.close();
  });
});
