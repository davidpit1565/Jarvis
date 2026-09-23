import { describe, test, expect, afterEach } from "bun:test";
import { EventBus } from "@/core/events/EventBus";
import { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import { PairingService } from "@/devices/pairing/PairingService";
import { DeviceConnectionManager } from "@/communication/websocket/DeviceConnectionManager";
import { JarvisWebSocketServer } from "@/communication/websocket/JarvisWebSocketServer";
import type { Orchestrator } from "@/core/orchestrator/Orchestrator";

/**
 * Exercises JarvisWebSocketServer.requestWebChatConfirmation() end to
 * end — the fix for a real gap a security review found: a CONFIRM-level
 * tool call (SEND_EMAIL, WRITE_FILE, CLICK_ELEMENT, ...) made via the
 * hologram chat used to silently route its yes/no prompt to the
 * server's own terminal stdin, invisible to the browser, always denying
 * after the 60s ConfirmationService timeout. Same shape as
 * TelegramGateway's own awaitConfirmation, tested the same way.
 */
function setupServer() {
  const eventBus = new EventBus();
  const deviceRegistry = new DeviceRegistry();
  const pairingService = new PairingService();
  const deviceConnectionManager = new DeviceConnectionManager(eventBus);
  const webChatOrchestrator = { handleUserMessage: async () => "unused" } as unknown as Orchestrator;

  const server = new JarvisWebSocketServer({
    deviceRegistry,
    deviceConnectionManager,
    pairingService,
    eventBus,
    webChatOrchestrator,
  });
  const handle = server.start(0);
  return { handle, port: handle.port, server };
}

function connect(port: number | undefined): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/chat`);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("socket failed to open"));
    setTimeout(() => reject(new Error("Timed out opening socket")), 2000);
  });
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    ws.onmessage = (event) => resolve(JSON.parse(event.data as string));
    setTimeout(() => reject(new Error("Timed out waiting for a message")), 2000);
  });
}

describe("JarvisWebSocketServer web-chat confirmation", () => {
  let activeHandle: { stop: () => void } | undefined;

  afterEach(() => {
    activeHandle?.stop();
    activeHandle = undefined;
  });

  test("hasWebChatConnection is false with nobody connected", () => {
    const { handle, server } = setupServer();
    activeHandle = handle;
    expect(server.hasWebChatConnection).toBe(false);
  });

  test("hasWebChatConnection becomes true once a browser connects", async () => {
    const { handle, port, server } = setupServer();
    activeHandle = handle;

    const ws = await connect(port);
    expect(server.hasWebChatConnection).toBe(true);
    ws.close();
  });

  test("requestWebChatConfirmation resolves false immediately with nobody connected", async () => {
    const { handle, server } = setupServer();
    activeHandle = handle;

    const result = await server.requestWebChatConfirmation("Approve?");
    expect(result).toBe(false);
  });

  test("sends a real confirm message and resolves true on a yes reply", async () => {
    const { handle, port, server } = setupServer();
    activeHandle = handle;

    const ws = await connect(port);
    const confirmPromise = server.requestWebChatConfirmation("Send this email?");

    const confirmMsg = await nextMessage(ws);
    expect(confirmMsg).toEqual({ type: "confirm", message: "Send this email?" });

    const replyPromise = nextMessage(ws);
    ws.send(JSON.stringify({ text: "yes" }));

    expect(await confirmPromise).toBe(true);
    expect(await replyPromise).toEqual({ type: "assistant", text: "Confirmed." });
    ws.close();
  });

  test("resolves false on a no reply", async () => {
    const { handle, port, server } = setupServer();
    activeHandle = handle;

    const ws = await connect(port);
    const confirmPromise = server.requestWebChatConfirmation("Send this email?");
    await nextMessage(ws); // the confirm prompt itself

    const replyPromise = nextMessage(ws);
    ws.send(JSON.stringify({ text: "no" }));

    expect(await confirmPromise).toBe(false);
    expect(await replyPromise).toEqual({ type: "assistant", text: "Cancelled." });
    ws.close();
  });

  test("recognizes Hebrew yes/no, same as Telegram's own pattern", async () => {
    const { handle, port, server } = setupServer();
    activeHandle = handle;

    const ws = await connect(port);
    const confirmPromise = server.requestWebChatConfirmation("לאשר?");
    await nextMessage(ws);
    ws.send(JSON.stringify({ text: "כן" }));

    expect(await confirmPromise).toBe(true);
    ws.close();
  });

  test("re-prompts on an unrecognized reply instead of treating it as an answer", async () => {
    const { handle, port, server } = setupServer();
    activeHandle = handle;

    const ws = await connect(port);
    const confirmPromise = server.requestWebChatConfirmation("Approve?");
    await nextMessage(ws);

    const rePromptPromise = nextMessage(ws);
    ws.send(JSON.stringify({ text: "what does that mean" }));
    expect(await rePromptPromise).toEqual({ type: "assistant", text: "Please reply yes or no." });

    const replyPromise = nextMessage(ws);
    ws.send(JSON.stringify({ text: "yes" }));
    expect(await confirmPromise).toBe(true);
    expect(await replyPromise).toEqual({ type: "assistant", text: "Confirmed." });
    ws.close();
  });

  test("denies a pending confirmation when the socket disconnects before answering", async () => {
    const { handle, port, server } = setupServer();
    activeHandle = handle;

    const ws = await connect(port);
    const confirmPromise = server.requestWebChatConfirmation("Approve?");
    await nextMessage(ws);

    ws.close();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(await confirmPromise).toBe(false);
  });

  test("a new connection replacing the active one denies any confirmation still pending on the old one", async () => {
    const { handle, port, server } = setupServer();
    activeHandle = handle;

    const ws1 = await connect(port);
    const confirmPromise = server.requestWebChatConfirmation("Approve?");
    await nextMessage(ws1);

    const ws2 = await connect(port);
    expect(await confirmPromise).toBe(false);

    ws1.close();
    ws2.close();
  });

  test("an unanswered confirmation times out to false and clears the pending entry, instead of bricking the chat", async () => {
    const { handle, port, server } = setupServer();
    activeHandle = handle;

    const ws = await connect(port);
    const confirmPromise = server.requestWebChatConfirmation("Approve?", 10);
    await nextMessage(ws); // the confirm prompt itself

    expect(await confirmPromise).toBe(false);

    // A normal message sent afterward must reach the orchestrator (echoed
    // back as its real reply) — not get treated as a stale yes/no answer.
    const replyPromise = nextMessage(ws);
    ws.send(JSON.stringify({ text: "what's the weather" }));

    expect(await replyPromise).toEqual({ type: "assistant", text: "unused" });
    ws.close();
  });
});
