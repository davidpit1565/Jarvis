import { describe, test, expect, afterEach } from "bun:test";
import { EventBus } from "@/core/events/EventBus";
import { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import { PairingService } from "@/devices/pairing/PairingService";
import { DeviceConnectionManager } from "@/communication/websocket/DeviceConnectionManager";
import { JarvisWebSocketServer } from "@/communication/websocket/JarvisWebSocketServer";
import { TelegramGateway, type TelegramSession } from "@/communication/telegram/TelegramGateway";
import type { Orchestrator } from "@/core/orchestrator/Orchestrator";

const WEBHOOK_SECRET = "test-webhook-secret";
const originalFetch = global.fetch;

function makeStubSessionFactory(handle: (message: string) => Promise<string>) {
  return (): TelegramSession => ({
    orchestrator: { handleUserMessage: async (_userId: string, message: string) => handle(message) } as unknown as Orchestrator,
    userId: "local-user",
  });
}

function setupServer(sessionFactory: () => TelegramSession, telegramAllowedChatIds?: string[]) {
  const eventBus = new EventBus();
  const deviceRegistry = new DeviceRegistry();
  const pairingService = new PairingService();
  const deviceConnectionManager = new DeviceConnectionManager(eventBus);
  const telegramGateway = new TelegramGateway("bot-token", sessionFactory, telegramAllowedChatIds);

  const server = new JarvisWebSocketServer({
    deviceRegistry,
    deviceConnectionManager,
    pairingService,
    eventBus,
    telegramGateway,
    telegramWebhookSecret: WEBHOOK_SECRET,
  });
  const handle = server.start(0);
  return { handle, port: handle.port };
}

describe("Telegram webhook HTTP routing", () => {
  let activeHandle: { stop: () => void } | undefined;

  afterEach(() => {
    activeHandle?.stop();
    activeHandle = undefined;
    global.fetch = originalFetch;
  });

  function stubTelegramSend() {
    global.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
  }

  test("a correctly-secreted update is accepted and processed", async () => {
    stubTelegramSend();
    const { handle, port } = setupServer(makeStubSessionFactory(async () => "reply"));
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/telegram/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET },
      body: JSON.stringify({ message: { chat: { id: 123 }, text: "hi" } }),
    });

    expect(response.status).toBe(200);
  });

  test("a missing secret token is rejected with 403", async () => {
    const { handle, port } = setupServer(makeStubSessionFactory(async () => "unused"));
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/telegram/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: { chat: { id: 123 }, text: "hi" } }),
    });

    expect(response.status).toBe(403);
  });

  test("an incorrect secret token is rejected with 403", async () => {
    const { handle, port } = setupServer(makeStubSessionFactory(async () => "unused"));
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/telegram/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "wrong" },
      body: JSON.stringify({ message: { chat: { id: 123 }, text: "hi" } }),
    });

    expect(response.status).toBe(403);
  });

  test("malformed JSON is rejected with 400", async () => {
    const { handle, port } = setupServer(makeStubSessionFactory(async () => "unused"));
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/telegram/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET },
      body: "{not valid json",
    });

    expect(response.status).toBe(400);
  });

  test("too many attempts from the same IP are rate-limited with 429", async () => {
    const { handle, port } = setupServer(makeStubSessionFactory(async () => "unused"));
    activeHandle = handle;

    let lastStatus = 0;
    for (let i = 0; i < 11; i++) {
      const response = await fetch(`http://localhost:${port}/telegram/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "wrong" },
        body: JSON.stringify({ message: { chat: { id: 123 }, text: "hi" } }),
      });
      lastStatus = response.status;
    }

    expect(lastStatus).toBe(429);
  });

  test("/telegram/webhook 404s when the Telegram gateway isn't configured", async () => {
    const eventBus = new EventBus();
    const server = new JarvisWebSocketServer({
      deviceRegistry: new DeviceRegistry(),
      deviceConnectionManager: new DeviceConnectionManager(eventBus),
      pairingService: new PairingService(),
      eventBus,
      // no telegramGateway / telegramWebhookSecret
    });
    const handle = server.start(0);
    activeHandle = handle;

    const response = await fetch(`http://localhost:${handle.port}/telegram/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: { chat: { id: 123 }, text: "hi" } }),
    });

    expect(response.status).toBe(404);
  });
});
