import { describe, test, expect, afterEach } from "bun:test";
import { EventBus } from "@/core/events/EventBus";
import { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import { PairingService } from "@/devices/pairing/PairingService";
import { DeviceConnectionManager } from "@/communication/websocket/DeviceConnectionManager";
import { JarvisWebSocketServer } from "@/communication/websocket/JarvisWebSocketServer";
import type { Orchestrator } from "@/core/orchestrator/Orchestrator";

/**
 * Regression test — found live: once every configured AI provider was
 * exhausted, ws(s)://.../chat sent the raw thrown error straight to the
 * user, including a full upstream provider error body ("OpenRouter chat
 * completion failed (429): {\"error\":{\"message\":...}}"). Every other
 * channel (Telegram, SMS, voice) already replies with a generic, friendly
 * message on a thrown error — this is the web chat panel's own version of
 * that same guarantee.
 */
function setupServerWithThrowingOrchestrator(errorMessage: string) {
  const eventBus = new EventBus();
  const deviceRegistry = new DeviceRegistry();
  const pairingService = new PairingService();
  const deviceConnectionManager = new DeviceConnectionManager(eventBus);

  const webChatOrchestrator = {
    handleUserMessage: async () => {
      throw new Error(errorMessage);
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

function connectAndSend(port: number | undefined, payload: unknown): Promise<{ ws: WebSocket; response: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/chat`);
    ws.onopen = () => ws.send(JSON.stringify(payload));
    ws.onmessage = (event) => resolve({ ws, response: JSON.parse(event.data as string) });
    ws.onerror = () => reject(new Error("socket failed to open"));
    setTimeout(() => reject(new Error("Timed out waiting for a response")), 2000);
  });
}

describe("ws(s)://.../chat error sanitization", () => {
  let activeHandle: { stop: () => void } | undefined;

  afterEach(() => {
    activeHandle?.stop();
    activeHandle = undefined;
  });

  test("a raw upstream provider error is replaced with a friendly message, not sent verbatim", async () => {
    const rawError =
      'OpenRouter chat completion failed (429): {"error":{"message":"Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day","code":429}}';
    const { handle, port } = setupServerWithThrowingOrchestrator(rawError);
    activeHandle = handle;

    const { ws, response } = await connectAndSend(port, { text: "hi" });

    expect(response.type).toBe("error");
    expect(response.message).toBe("Sorry, something went wrong on my end. Please try again.");
    expect(response.message).not.toContain("OpenRouter");
    expect(response.message).not.toContain("429");
    expect(response.message).not.toContain("Rate limit exceeded");
    ws.close();
  });
});
