import { describe, test, expect, afterEach } from "bun:test";
import { EventBus } from "@/core/events/EventBus";
import { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import { PairingService } from "@/devices/pairing/PairingService";
import { DeviceConnectionManager } from "@/communication/websocket/DeviceConnectionManager";
import { JarvisWebSocketServer } from "@/communication/websocket/JarvisWebSocketServer";
import type { Orchestrator } from "@/core/orchestrator/Orchestrator";

/**
 * Exercises ws(s)://.../chat's real end-to-end handling of an attached
 * image (see JarvisWebSocketServer.handleWebChatMessage and
 * isValidWebChatImage) — this is the browser-facing half of the vision
 * feature; Orchestrator/ConversationManager/ClaudeBrain's own handling of
 * the image once it arrives is covered separately in their own test
 * files.
 */
function setupServer() {
  const eventBus = new EventBus();
  const deviceRegistry = new DeviceRegistry();
  const pairingService = new PairingService();
  const deviceConnectionManager = new DeviceConnectionManager(eventBus);

  const calls: Array<{ userId: string; content: string; images: unknown }> = [];
  const webChatOrchestrator = {
    handleUserMessage: async (userId: string, content: string, images?: unknown) => {
      calls.push({ userId, content, images });
      return "mocked reply";
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
  return { handle, port: handle.port, calls };
}

function connectAndSend(
  port: number | undefined,
  payload: unknown
): Promise<{ ws: WebSocket; response: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/chat`);
    ws.onopen = () => ws.send(JSON.stringify(payload));
    ws.onmessage = (event) => resolve({ ws, response: JSON.parse(event.data as string) });
    ws.onerror = () => reject(new Error("socket failed to open"));
    setTimeout(() => reject(new Error("Timed out waiting for a response")), 2000);
  });
}

describe("ws(s)://.../chat image handling", () => {
  let activeHandle: { stop: () => void } | undefined;

  afterEach(() => {
    activeHandle?.stop();
    activeHandle = undefined;
  });

  test("a text-only message still works exactly as before", async () => {
    const { handle, port, calls } = setupServer();
    activeHandle = handle;

    const { ws, response } = await connectAndSend(port, { text: "hello" });
    expect(response).toEqual({ type: "assistant", text: "mocked reply" });
    expect(calls).toEqual([{ userId: "local-user", content: "hello", images: undefined }]);
    ws.close();
  });

  test("a single image via the singular `image` field is forwarded to the orchestrator", async () => {
    const { handle, port, calls } = setupServer();
    activeHandle = handle;

    const { ws, response } = await connectAndSend(port, {
      text: "what's this?",
      image: { mediaType: "image/png", data: "abc123" },
    });

    expect(response).toEqual({ type: "assistant", text: "mocked reply" });
    expect(calls).toEqual([
      { userId: "local-user", content: "what's this?", images: [{ mediaType: "image/png", data: "abc123" }] },
    ]);
    ws.close();
  });

  test("multiple images via the plural `images` field are all forwarded, in order", async () => {
    const { handle, port, calls } = setupServer();
    activeHandle = handle;

    const { ws } = await connectAndSend(port, {
      text: "compare these",
      images: [
        { mediaType: "image/jpeg", data: "first" },
        { mediaType: "image/webp", data: "second" },
      ],
    });

    expect(calls[0]?.images).toEqual([
      { mediaType: "image/jpeg", data: "first" },
      { mediaType: "image/webp", data: "second" },
    ]);
    ws.close();
  });

  test("an image with no caption text is accepted (image-only turn)", async () => {
    const { handle, port, calls } = setupServer();
    activeHandle = handle;

    const { ws, response } = await connectAndSend(port, { image: { mediaType: "image/png", data: "abc" } });

    expect(response).toEqual({ type: "assistant", text: "mocked reply" });
    expect(calls[0]?.content).toBe("");
    ws.close();
  });

  test("rejects an image with an unsupported mediaType", async () => {
    const { handle, port, calls } = setupServer();
    activeHandle = handle;

    const { ws, response } = await connectAndSend(port, {
      text: "hi",
      image: { mediaType: "image/svg+xml", data: "abc" },
    });

    expect(response.type).toBe("error");
    expect(calls).toHaveLength(0);
    ws.close();
  });

  test("rejects an image missing its data field", async () => {
    const { handle, port, calls } = setupServer();
    activeHandle = handle;

    const { ws, response } = await connectAndSend(port, { text: "hi", image: { mediaType: "image/png" } });

    expect(response.type).toBe("error");
    expect(calls).toHaveLength(0);
    ws.close();
  });

  test("rejects a message with neither text nor an image", async () => {
    const { handle, port, calls } = setupServer();
    activeHandle = handle;

    const { ws, response } = await connectAndSend(port, {});

    expect(response.type).toBe("error");
    expect(calls).toHaveLength(0);
    ws.close();
  });
});
