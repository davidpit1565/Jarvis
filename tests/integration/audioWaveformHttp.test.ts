import { describe, test, expect, afterEach } from "bun:test";
import { createHmac } from "node:crypto";
import { EventBus } from "@/core/events/EventBus";
import { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import { PairingService } from "@/devices/pairing/PairingService";
import { DeviceConnectionManager } from "@/communication/websocket/DeviceConnectionManager";
import { JarvisWebSocketServer } from "@/communication/websocket/JarvisWebSocketServer";
import { AudioLevelBroadcaster } from "@/communication/websocket/AudioLevelBroadcaster";

const AUTH_TOKEN = "test-auth-token";
const PUBLIC_BASE_URL = "https://example.ngrok.io";

function sign(url: string): string {
  return createHmac("sha1", AUTH_TOKEN).update(url, "utf8").digest("base64");
}

function setupServer(audioLevelBroadcaster?: AudioLevelBroadcaster, requireTwilioSignature = false) {
  const eventBus = new EventBus();
  const server = new JarvisWebSocketServer({
    deviceRegistry: new DeviceRegistry(),
    deviceConnectionManager: new DeviceConnectionManager(eventBus),
    pairingService: new PairingService(),
    eventBus,
    audioLevelBroadcaster,
    ...(requireTwilioSignature ? { twilioAuthToken: AUTH_TOKEN, twilioPublicBaseUrl: PUBLIC_BASE_URL } : {}),
  });
  const handle = server.start(0);
  return { handle, port: handle.port };
}

describe("Audio waveform routes", () => {
  let activeHandle: { stop: () => void } | undefined;

  afterEach(() => {
    activeHandle?.stop();
    activeHandle = undefined;
  });

  test("/voice/audio-stream and /dashboard/audio-ws are unreachable when the feature is disabled", async () => {
    const { handle, port } = setupServer(undefined);
    activeHandle = handle;

    const ingestResponse = await fetch(`http://localhost:${port}/voice/audio-stream`, {
      headers: { Upgrade: "websocket", Connection: "Upgrade" },
    });
    expect(ingestResponse.status).toBe(404);

    const viewerResponse = await fetch(`http://localhost:${port}/dashboard/audio-ws`, {
      headers: { Upgrade: "websocket", Connection: "Upgrade" },
    });
    expect(viewerResponse.status).toBe(404);
  });

  test("GET /status reports audioWaveformEnabled based on whether the feature is configured", async () => {
    const disabled = setupServer(undefined);
    activeHandle = disabled.handle;
    const disabledData = (await (await fetch(`http://localhost:${disabled.port}/status`)).json()) as {
      audioWaveformEnabled: boolean;
    };
    expect(disabledData.audioWaveformEnabled).toBe(false);
    disabled.handle.stop();

    const enabled = setupServer(new AudioLevelBroadcaster());
    activeHandle = enabled.handle;
    const enabledData = (await (await fetch(`http://localhost:${enabled.port}/status`)).json()) as {
      audioWaveformEnabled: boolean;
    };
    expect(enabledData.audioWaveformEnabled).toBe(true);
  });

  test("a dashboard viewer receives a real-time level broadcast when Twilio sends a media event", async () => {
    const broadcaster = new AudioLevelBroadcaster();
    const { handle, port } = setupServer(broadcaster, true);
    activeHandle = handle;

    const viewerSocket = new WebSocket(`ws://localhost:${port}/dashboard/audio-ws`);
    const levelPromise = new Promise<{ type: string; level: number; track: string }>((resolve, reject) => {
      viewerSocket.onmessage = (event) => resolve(JSON.parse(event.data as string));
      viewerSocket.onerror = () => reject(new Error("viewer socket error"));
      setTimeout(() => reject(new Error("timed out waiting for a level broadcast")), 2000);
    });
    await new Promise<void>((resolve, reject) => {
      viewerSocket.onopen = () => resolve();
      viewerSocket.onerror = () => reject(new Error("viewer socket failed to open"));
    });

    const signature = sign(`${PUBLIC_BASE_URL}/voice/audio-stream`);
    const ingestSocket = new WebSocket(`ws://localhost:${port}/voice/audio-stream`, {
      headers: { "X-Twilio-Signature": signature },
    } as unknown as string[]);
    await new Promise<void>((resolve, reject) => {
      ingestSocket.onopen = () => resolve();
      ingestSocket.onerror = () => reject(new Error("ingest socket failed to open"));
    });

    // A real Twilio "media" event shape (loudest possible mu-law byte, 0x00, repeated).
    const payload = Buffer.alloc(160, 0x00).toString("base64");
    ingestSocket.send(
      JSON.stringify({
        event: "media",
        sequenceNumber: "3",
        media: { track: "inbound", chunk: "1", timestamp: "5", payload },
        streamSid: "MZ00000000000000000000000000000000",
      })
    );

    const received = await levelPromise;
    expect(received.type).toBe("level");
    expect(received.track).toBe("inbound");
    expect(received.level).toBeGreaterThan(0.9);

    viewerSocket.close();
    ingestSocket.close();
  });

  test("rejects a /voice/audio-stream upgrade with no Twilio signature once twilioAuthToken/twilioPublicBaseUrl are configured", async () => {
    const { handle, port } = setupServer(new AudioLevelBroadcaster(), true);
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/voice/audio-stream`, {
      headers: { Upgrade: "websocket", Connection: "Upgrade" },
    });
    expect(response.status).toBe(403);
  });

  test("rejects a /voice/audio-stream upgrade with a wrong Twilio signature", async () => {
    const { handle, port } = setupServer(new AudioLevelBroadcaster(), true);
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/voice/audio-stream`, {
      headers: { Upgrade: "websocket", Connection: "Upgrade", "X-Twilio-Signature": "forged" },
    });
    expect(response.status).toBe(403);
  });

  test("accepts a /voice/audio-stream upgrade carrying a correctly signed X-Twilio-Signature", async () => {
    const broadcaster = new AudioLevelBroadcaster();
    const { handle, port } = setupServer(broadcaster, true);
    activeHandle = handle;

    const signature = sign(`${PUBLIC_BASE_URL}/voice/audio-stream`);
    const ingestSocket = new WebSocket(`ws://localhost:${port}/voice/audio-stream`, {
      headers: { "X-Twilio-Signature": signature },
    } as unknown as string[]);

    await new Promise<void>((resolve, reject) => {
      ingestSocket.onopen = () => resolve();
      ingestSocket.onerror = () => reject(new Error("ingest socket failed to open with a valid signature"));
      setTimeout(() => reject(new Error("timed out waiting for the signed socket to open")), 2000);
    });

    ingestSocket.close();
  });

  test("rejects a /voice/audio-stream upgrade with 404 when audioLevelBroadcaster is configured but twilioAuthToken is missing (fails closed, not open)", async () => {
    // The waveform feature only requires audioWaveformEnabled +
    // twilioPublicBaseUrl to construct AudioLevelBroadcaster (see
    // index.ts) — it does NOT require twilioAuthToken. Without this
    // route explicitly requiring the token too, a deploy with the
    // waveform on but no TWILIO_AUTH_TOKEN set (e.g. rotated out, or
    // tried without the phone gateway) would skip signature
    // verification entirely and accept any connection.
    const { handle, port } = setupServer(new AudioLevelBroadcaster(), false);
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/voice/audio-stream`, {
      headers: { Upgrade: "websocket", Connection: "Upgrade" },
    });
    expect(response.status).toBe(404);
  });

  test("non-media Twilio events (connected/start/stop) are ignored without error", async () => {
    const broadcaster = new AudioLevelBroadcaster();
    const { handle, port } = setupServer(broadcaster, true);
    activeHandle = handle;

    const signature = sign(`${PUBLIC_BASE_URL}/voice/audio-stream`);
    const ingestSocket = new WebSocket(`ws://localhost:${port}/voice/audio-stream`, {
      headers: { "X-Twilio-Signature": signature },
    } as unknown as string[]);
    await new Promise<void>((resolve, reject) => {
      ingestSocket.onopen = () => resolve();
      ingestSocket.onerror = () => reject(new Error("ingest socket failed to open"));
    });

    ingestSocket.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
    ingestSocket.send(
      JSON.stringify({
        event: "start",
        sequenceNumber: "1",
        start: { accountSid: "AC1", streamSid: "MZ1", callSid: "CA1", tracks: ["inbound"] },
        streamSid: "MZ1",
      })
    );
    ingestSocket.send(JSON.stringify({ event: "stop", sequenceNumber: "5", stop: { accountSid: "AC1", callSid: "CA1" } }));

    // No crash, no broadcast triggered by these — give the event loop a tick.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(broadcaster.viewerCount).toBe(0);

    ingestSocket.close();
  });
});
