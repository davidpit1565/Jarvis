import { describe, test, expect } from "bun:test";
import {
  parseDeviceToCoreMessage,
  parseCoreToDeviceMessage,
  makeEnvelope,
} from "@/communication/websocket/protocol";

function baseEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "req-1",
    timestamp: new Date().toISOString(),
    deviceId: "imac-1",
    type: "device.status",
    payload: { status: "online" },
    ...overrides,
  };
}

describe("WebSocket protocol: device -> core", () => {
  test("parses a valid device.register message with deviceId null (first pairing)", () => {
    const result = parseDeviceToCoreMessage(
      JSON.stringify(
        baseEnvelope({
          deviceId: null,
          type: "device.register",
          payload: {
            deviceName: "David's iMac",
            deviceType: "mac",
            platform: "macos",
            agentVersion: "0.1.0",
            protocolVersion: "1",
            capabilities: ["get_active_application"],
            requestedRole: "primary",
          },
        })
      )
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message.type).toBe("device.register");
      expect(result.message.deviceId).toBeNull();
    }
  });

  test("parses a valid device.register message reconnecting with a known deviceId and credential", () => {
    const result = parseDeviceToCoreMessage(
      JSON.stringify(
        baseEnvelope({
          type: "device.register",
          payload: {
            deviceName: "David's iMac",
            deviceType: "mac",
            platform: "macos",
            agentVersion: "0.1.0",
            protocolVersion: "1",
            capabilities: [],
            credential: "some-long-lived-secret",
          },
        })
      )
    );

    expect(result.ok).toBe(true);
  });

  test("parses a valid device.status message", () => {
    const result = parseDeviceToCoreMessage(JSON.stringify(baseEnvelope()));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.message.type).toBe("device.status");
  });

  test("parses a valid tool.result message", () => {
    const result = parseDeviceToCoreMessage(
      JSON.stringify(baseEnvelope({ type: "tool.result", payload: { success: true, data: { ok: true } } }))
    );
    expect(result.ok).toBe(true);
  });

  test("parses a valid event message", () => {
    const result = parseDeviceToCoreMessage(
      JSON.stringify(baseEnvelope({ type: "event", payload: { name: "device.connected" } }))
    );
    expect(result.ok).toBe(true);
  });

  test("parses a valid pong message", () => {
    const result = parseDeviceToCoreMessage(JSON.stringify(baseEnvelope({ type: "pong", payload: {} })));
    expect(result.ok).toBe(true);
  });

  test("parses a valid voice.transcript message", () => {
    const result = parseDeviceToCoreMessage(
      JSON.stringify(baseEnvelope({ type: "voice.transcript", payload: { text: "what's on my calendar today" } }))
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.message.type === "voice.transcript") {
      expect(result.message.payload.text).toBe("what's on my calendar today");
    }
  });

  test("parses a valid voice.transcript message with an optional wakeWord", () => {
    const result = parseDeviceToCoreMessage(
      JSON.stringify(baseEnvelope({ type: "voice.transcript", payload: { text: "pause the music", wakeWord: "hey jarvis" } }))
    );
    expect(result.ok).toBe(true);
  });

  test("rejects a voice.transcript message with an empty text", () => {
    const result = parseDeviceToCoreMessage(
      JSON.stringify(baseEnvelope({ type: "voice.transcript", payload: { text: "" } }))
    );
    expect(result.ok).toBe(false);
  });

  test("rejects a voice.transcript message with deviceId null", () => {
    const result = parseDeviceToCoreMessage(
      JSON.stringify(baseEnvelope({ deviceId: null, type: "voice.transcript", payload: { text: "hello" } }))
    );
    expect(result.ok).toBe(false);
  });

  test("rejects invalid JSON", () => {
    const result = parseDeviceToCoreMessage("not json");
    expect(result.ok).toBe(false);
  });

  test("rejects a message with an unknown type", () => {
    const result = parseDeviceToCoreMessage(JSON.stringify(baseEnvelope({ type: "mystery" })));
    expect(result.ok).toBe(false);
  });

  test("rejects a message missing requestId", () => {
    const raw = JSON.stringify(baseEnvelope());
    const parsed = JSON.parse(raw);
    delete parsed.requestId;
    const result = parseDeviceToCoreMessage(JSON.stringify(parsed));
    expect(result.ok).toBe(false);
  });

  test("rejects a message missing timestamp", () => {
    const raw = JSON.parse(JSON.stringify(baseEnvelope()));
    delete raw.timestamp;
    const result = parseDeviceToCoreMessage(JSON.stringify(raw));
    expect(result.ok).toBe(false);
  });

  test("rejects a malformed payload", () => {
    const result = parseDeviceToCoreMessage(JSON.stringify(baseEnvelope({ payload: { status: "not-a-status" } })));
    expect(result.ok).toBe(false);
  });

  test("rejects a device.status message with deviceId null (only device.register may omit it)", () => {
    const result = parseDeviceToCoreMessage(JSON.stringify(baseEnvelope({ deviceId: null })));
    expect(result.ok).toBe(false);
  });

  test("rejects a tool.result message with deviceId null", () => {
    const result = parseDeviceToCoreMessage(
      JSON.stringify(baseEnvelope({ deviceId: null, type: "tool.result", payload: { success: true } }))
    );
    expect(result.ok).toBe(false);
  });

  test("rejects payload that is not an object", () => {
    const result = parseDeviceToCoreMessage(JSON.stringify(baseEnvelope({ payload: "not-an-object" })));
    expect(result.ok).toBe(false);
  });

  test("rejects a message that is not a JSON object at all", () => {
    const result = parseDeviceToCoreMessage(JSON.stringify(["not", "an", "object"]));
    expect(result.ok).toBe(false);
  });
});

describe("WebSocket protocol: core -> device", () => {
  test("parses a valid tool.request message", () => {
    const result = parseCoreToDeviceMessage(
      JSON.stringify(baseEnvelope({ type: "tool.request", payload: { tool: "get_active_application", input: {} } }))
    );
    expect(result.ok).toBe(true);
  });

  test("parses a valid device.command message", () => {
    const result = parseCoreToDeviceMessage(
      JSON.stringify(baseEnvelope({ type: "device.command", payload: { command: "pairing.approved" } }))
    );
    expect(result.ok).toBe(true);
  });

  test("parses a valid ping message", () => {
    const result = parseCoreToDeviceMessage(JSON.stringify(baseEnvelope({ type: "ping", payload: {} })));
    expect(result.ok).toBe(true);
  });

  test("parses a valid voice.reply message", () => {
    const result = parseCoreToDeviceMessage(
      JSON.stringify(baseEnvelope({ type: "voice.reply", payload: { text: "You have three meetings today." } }))
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.message.type === "voice.reply") {
      expect(result.message.payload.text).toBe("You have three meetings today.");
    }
  });

  test("rejects a voice.reply with a null deviceId", () => {
    const result = parseCoreToDeviceMessage(
      JSON.stringify(baseEnvelope({ deviceId: null, type: "voice.reply", payload: { text: "hi" } }))
    );
    expect(result.ok).toBe(false);
  });

  test("rejects a tool.request with a null deviceId", () => {
    const result = parseCoreToDeviceMessage(
      JSON.stringify(baseEnvelope({ deviceId: null, type: "tool.request", payload: { tool: "x", input: {} } }))
    );
    expect(result.ok).toBe(false);
  });

  test("rejects a malformed tool.request payload (missing input)", () => {
    const result = parseCoreToDeviceMessage(
      JSON.stringify(baseEnvelope({ type: "tool.request", payload: { tool: "x" } }))
    );
    expect(result.ok).toBe(false);
  });
});

describe("makeEnvelope", () => {
  test("produces an envelope that round-trips through parseCoreToDeviceMessage", () => {
    const envelope = makeEnvelope("ping", {}, "imac-1", "req-42");
    const result = parseCoreToDeviceMessage(JSON.stringify(envelope));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message.requestId).toBe("req-42");
      expect(result.message.deviceId).toBe("imac-1");
    }
  });
});
