import { describe, test, expect, afterEach } from "bun:test";
import { createHmac } from "node:crypto";
import { EventBus } from "@/core/events/EventBus";
import { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import { PairingService } from "@/devices/pairing/PairingService";
import { DeviceConnectionManager } from "@/communication/websocket/DeviceConnectionManager";
import { JarvisWebSocketServer } from "@/communication/websocket/JarvisWebSocketServer";
import { TwilioVoiceGateway, type PhoneSession } from "@/communication/phone/TwilioVoiceGateway";
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
  return (): PhoneSession => ({
    orchestrator: { handleUserMessage: async (_userId: string, message: string) => handle(message) } as unknown as Orchestrator,
    userId: "local-user",
  });
}

function setupServer(sessionFactory: () => PhoneSession, twilioAllowedCallers?: string[]) {
  const eventBus = new EventBus();
  const deviceRegistry = new DeviceRegistry();
  const pairingService = new PairingService();
  const deviceConnectionManager = new DeviceConnectionManager(eventBus);
  const phoneGateway = new TwilioVoiceGateway(sessionFactory);

  const server = new JarvisWebSocketServer({
    deviceRegistry,
    deviceConnectionManager,
    pairingService,
    eventBus,
    phoneGateway,
    twilioAuthToken: AUTH_TOKEN,
    twilioPublicBaseUrl: PUBLIC_BASE_URL,
    twilioAllowedCallers,
  });
  const handle = server.start(0);
  return { handle, port: handle.port };
}

describe("Voice webhook HTTP routing", () => {
  let activeHandle: { stop: () => void } | undefined;

  afterEach(() => {
    activeHandle?.stop();
    activeHandle = undefined;
  });

  test("a correctly signed incoming-call webhook returns TwiML", async () => {
    const { handle, port } = setupServer(makeStubSessionFactory(async () => "unused"));
    activeHandle = handle;

    const path = "/voice/incoming";
    const params = { CallSid: "CA1", From: "+15551234567" };
    const signature = sign(`${PUBLIC_BASE_URL}${path}`, params);

    const response = await fetch(`http://localhost:${port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signature },
      body: new URLSearchParams(params),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/xml");
    const body = await response.text();
    expect(body).toContain("<Gather");
  });

  test("an unsigned request is rejected with 403", async () => {
    const { handle, port } = setupServer(makeStubSessionFactory(async () => "unused"));
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/voice/incoming`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ CallSid: "CA1" }),
    });

    expect(response.status).toBe(403);
  });

  test("a request signed for a different path is rejected with 403", async () => {
    const { handle, port } = setupServer(makeStubSessionFactory(async () => "unused"));
    activeHandle = handle;

    const params = { CallSid: "CA1" };
    const wrongSignature = sign(`${PUBLIC_BASE_URL}/voice/gather`, params); // signed for the wrong route

    const response = await fetch(`http://localhost:${port}/voice/incoming`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": wrongSignature },
      body: new URLSearchParams(params),
    });

    expect(response.status).toBe(403);
  });

  test("a real conversation turn flows from gather through the orchestrator and back as speech", async () => {
    const { handle, port } = setupServer(
      makeStubSessionFactory(async (message) => `You said: ${message}`)
    );
    activeHandle = handle;

    const path = "/voice/gather";
    const params = { CallSid: "CA1", SpeechResult: "what am I doing" };
    const signature = sign(`${PUBLIC_BASE_URL}${path}`, params);

    const response = await fetch(`http://localhost:${port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signature },
      body: new URLSearchParams(params),
    });

    const body = await response.text();
    expect(body).toContain("You said: what am I doing");
  });

  test("a caller not on the allowlist is turned away without reaching the orchestrator", async () => {
    let orchestratorCalled = false;
    const { handle, port } = setupServer(
      makeStubSessionFactory(async () => {
        orchestratorCalled = true;
        return "unused";
      }),
      ["+15559999999"]
    );
    activeHandle = handle;

    const path = "/voice/incoming";
    const params = { CallSid: "CA1", From: "+15551234567" };
    const signature = sign(`${PUBLIC_BASE_URL}${path}`, params);

    const response = await fetch(`http://localhost:${port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signature },
      body: new URLSearchParams(params),
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("isn't authorized");
    expect(body).toContain("<Hangup");
    expect(orchestratorCalled).toBe(false);
  });

  test("a caller on the allowlist is let through normally", async () => {
    const { handle, port } = setupServer(makeStubSessionFactory(async () => "unused"), ["+15551234567"]);
    activeHandle = handle;

    const path = "/voice/incoming";
    const params = { CallSid: "CA1", From: "+15551234567" };
    const signature = sign(`${PUBLIC_BASE_URL}${path}`, params);

    const response = await fetch(`http://localhost:${port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signature },
      body: new URLSearchParams(params),
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("<Gather");
  });

  test("/voice/* routes 404 when the phone gateway isn't configured", async () => {
    const eventBus = new EventBus();
    const server = new JarvisWebSocketServer({
      deviceRegistry: new DeviceRegistry(),
      deviceConnectionManager: new DeviceConnectionManager(eventBus),
      pairingService: new PairingService(),
      eventBus,
      // no phoneGateway / twilioAuthToken / twilioPublicBaseUrl
    });
    const handle = server.start(0);
    activeHandle = handle;

    const response = await fetch(`http://localhost:${handle.port}/voice/incoming`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ CallSid: "CA1" }),
    });

    expect(response.status).toBe(404);
  });
});
