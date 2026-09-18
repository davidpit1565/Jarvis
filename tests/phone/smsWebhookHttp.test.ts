import { describe, test, expect, afterEach } from "bun:test";
import { createHmac } from "node:crypto";
import { EventBus } from "@/core/events/EventBus";
import { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import { PairingService } from "@/devices/pairing/PairingService";
import { DeviceConnectionManager } from "@/communication/websocket/DeviceConnectionManager";
import { JarvisWebSocketServer } from "@/communication/websocket/JarvisWebSocketServer";
import { TwilioSmsGateway, type SmsSession } from "@/communication/phone/TwilioSmsGateway";
import type { Orchestrator } from "@/core/orchestrator/Orchestrator";

const AUTH_TOKEN = "test-auth-token";
const PUBLIC_BASE_URL = "https://example.ngrok.io";

function sign(url: string, params: Record<string, string>): string {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) data += key + params[key];
  return createHmac("sha1", AUTH_TOKEN).update(data, "utf8").digest("base64");
}

function makeStubSessionFactory(handle: (message: string) => Promise<string>) {
  return (): SmsSession => ({
    orchestrator: { handleUserMessage: async (_userId: string, message: string) => handle(message) } as unknown as Orchestrator,
    userId: "local-user",
  });
}

function setupServer(sessionFactory: () => SmsSession, twilioAllowedCallers?: string[]) {
  const eventBus = new EventBus();
  const deviceRegistry = new DeviceRegistry();
  const pairingService = new PairingService();
  const deviceConnectionManager = new DeviceConnectionManager(eventBus);
  const smsGateway = new TwilioSmsGateway(sessionFactory);

  const server = new JarvisWebSocketServer({
    deviceRegistry,
    deviceConnectionManager,
    pairingService,
    eventBus,
    smsGateway,
    twilioAuthToken: AUTH_TOKEN,
    twilioPublicBaseUrl: PUBLIC_BASE_URL,
    twilioAllowedCallers,
  });
  const handle = server.start(0);
  return { handle, port: handle.port };
}

describe("SMS webhook HTTP routing", () => {
  let activeHandle: { stop: () => void } | undefined;

  afterEach(() => {
    activeHandle?.stop();
    activeHandle = undefined;
  });

  test("a correctly signed incoming text flows through the orchestrator and back as TwiML", async () => {
    const { handle, port } = setupServer(makeStubSessionFactory(async (message) => `You said: ${message}`));
    activeHandle = handle;

    const path = "/sms/incoming";
    const params = { From: "+15551234567", Body: "what's on my calendar" };
    const signature = sign(`${PUBLIC_BASE_URL}${path}`, params);

    const response = await fetch(`http://localhost:${port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signature },
      body: new URLSearchParams(params),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/xml");
    const body = await response.text();
    expect(body).toContain("You said: what's on my calendar");
  });

  test("an unsigned request is rejected with 403", async () => {
    const { handle, port } = setupServer(makeStubSessionFactory(async () => "unused"));
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/sms/incoming`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ From: "+15551234567", Body: "hi" }),
    });

    expect(response.status).toBe(403);
  });

  test("a request signed for a different path is rejected with 403", async () => {
    const { handle, port } = setupServer(makeStubSessionFactory(async () => "unused"));
    activeHandle = handle;

    const params = { From: "+15551234567", Body: "hi" };
    const wrongSignature = sign(`${PUBLIC_BASE_URL}/voice/incoming`, params);

    const response = await fetch(`http://localhost:${port}/sms/incoming`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": wrongSignature },
      body: new URLSearchParams(params),
    });

    expect(response.status).toBe(403);
  });

  test("a text from a number not on the allowlist is silently dropped without reaching the orchestrator", async () => {
    let orchestratorCalled = false;
    const { handle, port } = setupServer(
      makeStubSessionFactory(async () => {
        orchestratorCalled = true;
        return "unused";
      }),
      ["+15559999999"]
    );
    activeHandle = handle;

    const path = "/sms/incoming";
    const params = { From: "+15551234567", Body: "hi" };
    const signature = sign(`${PUBLIC_BASE_URL}${path}`, params);

    const response = await fetch(`http://localhost:${port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signature },
      body: new URLSearchParams(params),
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain("unused");
    expect(orchestratorCalled).toBe(false);
  });

  test("a number on the allowlist is let through normally", async () => {
    const { handle, port } = setupServer(makeStubSessionFactory(async () => "Sure thing."), ["+15551234567"]);
    activeHandle = handle;

    const path = "/sms/incoming";
    const params = { From: "+15551234567", Body: "hi" };
    const signature = sign(`${PUBLIC_BASE_URL}${path}`, params);

    const response = await fetch(`http://localhost:${port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signature },
      body: new URLSearchParams(params),
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("Sure thing.");
  });

  test("two texts from different numbers get separate conversation sessions", async () => {
    const seenMessages: string[] = [];
    const { handle, port } = setupServer(
      makeStubSessionFactory(async (message) => {
        seenMessages.push(message);
        return `ack: ${message}`;
      })
    );
    activeHandle = handle;

    const path = "/sms/incoming";
    const exchanges: [string, string][] = [
      ["+15551111111", "first"],
      ["+15552222222", "second"],
    ];
    for (const [from, body] of exchanges) {
      const params = { From: from, Body: body };
      const signature = sign(`${PUBLIC_BASE_URL}${path}`, params);
      const response = await fetch(`http://localhost:${port}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signature },
        body: new URLSearchParams(params),
      });
      const text = await response.text();
      expect(text).toContain(`ack: ${body}`);
    }

    expect(seenMessages).toEqual(["first", "second"]);
  });

  test("/sms/incoming 404s when the SMS gateway isn't configured", async () => {
    const eventBus = new EventBus();
    const server = new JarvisWebSocketServer({
      deviceRegistry: new DeviceRegistry(),
      deviceConnectionManager: new DeviceConnectionManager(eventBus),
      pairingService: new PairingService(),
      eventBus,
      // no smsGateway / twilioAuthToken / twilioPublicBaseUrl
    });
    const handle = server.start(0);
    activeHandle = handle;

    const response = await fetch(`http://localhost:${handle.port}/sms/incoming`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ From: "+15551234567", Body: "hi" }),
    });

    expect(response.status).toBe(404);
  });
});
