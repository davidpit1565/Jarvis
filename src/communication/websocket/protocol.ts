import type { DeviceRole, DeviceStatus, DeviceType } from "@/types/devices";

/**
 * Typed message contract between JARVIS Core and device agents (iMac
 * first, iPhone/MacBook later). Every message is wrapped in this envelope
 * so Core and every device speak one consistent shape regardless of
 * platform. `deviceId` is only ever null for a device's very first
 * `device.register` before Core has assigned/confirmed its identity.
 */
export interface Envelope<TType extends string = string, TPayload = unknown> {
  requestId: string;
  timestamp: string;
  deviceId: string | null;
  type: TType;
  payload: TPayload;
}

export const PROTOCOL_VERSION = "1";

// ---------------------------------------------------------------------------
// Core -> Device payloads
// ---------------------------------------------------------------------------

export interface DeviceCommandPayload {
  command: string;
  args?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ToolRequestPayload {
  tool: string;
  input: Record<string, unknown>;
  [key: string]: unknown;
}

export type PingPayload = Record<string, never>;

/** The spoken-back reply to a voice.transcript — see VoiceTranscriptPayload below. */
export interface VoiceReplyPayload {
  text: string;
  [key: string]: unknown;
}

export type DeviceCommandMessage = Envelope<"device.command", DeviceCommandPayload>;
export type ToolRequestMessage = Envelope<"tool.request", ToolRequestPayload>;
export type PingMessage = Envelope<"ping", PingPayload>;
export type VoiceReplyMessage = Envelope<"voice.reply", VoiceReplyPayload>;

export type CoreToDeviceMessage = DeviceCommandMessage | ToolRequestMessage | PingMessage | VoiceReplyMessage;

// ---------------------------------------------------------------------------
// Device -> Core payloads
// ---------------------------------------------------------------------------

export interface DeviceRegisterPayload {
  deviceName: string;
  deviceType: DeviceType;
  platform: string;
  agentVersion: string;
  protocolVersion: string;
  capabilities: string[];
  /** The role the device would like — a request only, never authoritative. */
  requestedRole?: DeviceRole;
  /** Present only once the device has a stored credential from a prior pairing. */
  credential?: string;
  [key: string]: unknown;
}

export interface DeviceStatusPayload {
  status: DeviceStatus;
  [key: string]: unknown;
}

export interface ToolResultPayload {
  success: boolean;
  data?: unknown;
  error?: string;
  [key: string]: unknown;
}

export interface DeviceEventPayload {
  name: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export type PongPayload = Record<string, never>;

/**
 * A wake-word-triggered voice command transcribed on-device (e.g. "Hey
 * JARVIS, what's on my calendar") — the text after the wake phrase.
 * Routed through the same Orchestrator.handleUserMessage path as every
 * other channel (Telegram, phone), one conversation per device.
 */
export interface VoiceTranscriptPayload {
  text: string;
  wakeWord?: string;
  [key: string]: unknown;
}

export type DeviceRegisterMessage = Envelope<"device.register", DeviceRegisterPayload>;
export type DeviceStatusMessage = Envelope<"device.status", DeviceStatusPayload>;
export type ToolResultMessage = Envelope<"tool.result", ToolResultPayload>;
export type DeviceEventMessage = Envelope<"event", DeviceEventPayload>;
export type PongMessage = Envelope<"pong", PongPayload>;
export type VoiceTranscriptMessage = Envelope<"voice.transcript", VoiceTranscriptPayload>;

export type DeviceToCoreMessage =
  | DeviceRegisterMessage
  | DeviceStatusMessage
  | ToolResultMessage
  | DeviceEventMessage
  | PongMessage
  | VoiceTranscriptMessage;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ParseResult<T> = { ok: true; message: T } | { ok: false; reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface EnvelopeShape {
  requestId: string;
  timestamp: string;
  deviceId: string | null;
  type: string;
  payload: Record<string, unknown>;
}

/** Validates only the envelope, independent of what `type` it claims to be. */
function parseEnvelopeShape(raw: string): ParseResult<EnvelopeShape> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "Invalid JSON" };
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, reason: "Message must be a JSON object" };
  }

  if (typeof parsed.requestId !== "string" || parsed.requestId.trim() === "") {
    return { ok: false, reason: "Missing or invalid requestId" };
  }

  if (typeof parsed.timestamp !== "string" || parsed.timestamp.trim() === "") {
    return { ok: false, reason: "Missing or invalid timestamp" };
  }

  if (parsed.deviceId !== null && typeof parsed.deviceId !== "string") {
    return { ok: false, reason: "deviceId must be a string or null" };
  }

  if (typeof parsed.type !== "string" || parsed.type.trim() === "") {
    return { ok: false, reason: "Missing or invalid type" };
  }

  if (!isPlainObject(parsed.payload)) {
    return { ok: false, reason: "Missing or invalid payload" };
  }

  return {
    ok: true,
    message: {
      requestId: parsed.requestId,
      timestamp: parsed.timestamp,
      deviceId: parsed.deviceId as string | null,
      type: parsed.type,
      payload: parsed.payload,
    },
  };
}

function requireDeviceId(envelope: EnvelopeShape): ParseResult<string> {
  if (envelope.deviceId === null) {
    return { ok: false, reason: `deviceId is required for message type "${envelope.type}"` };
  }
  return { ok: true, message: envelope.deviceId };
}

function isDeviceRegisterPayload(payload: Record<string, unknown>): payload is DeviceRegisterPayload {
  return (
    typeof payload.deviceName === "string" &&
    (payload.deviceType === "mac" || payload.deviceType === "iphone") &&
    typeof payload.platform === "string" &&
    typeof payload.agentVersion === "string" &&
    typeof payload.protocolVersion === "string" &&
    Array.isArray(payload.capabilities) &&
    payload.capabilities.every((c) => typeof c === "string") &&
    (payload.requestedRole === undefined ||
      payload.requestedRole === "primary" ||
      payload.requestedRole === "secondary" ||
      payload.requestedRole === "mobile") &&
    (payload.credential === undefined || typeof payload.credential === "string")
  );
}

function isDeviceStatusPayload(payload: Record<string, unknown>): payload is DeviceStatusPayload {
  return payload.status === "online" || payload.status === "offline" || payload.status === "unknown";
}

function isToolResultPayload(payload: Record<string, unknown>): payload is ToolResultPayload {
  return (
    typeof payload.success === "boolean" &&
    (payload.error === undefined || typeof payload.error === "string")
  );
}

function isDeviceEventPayload(payload: Record<string, unknown>): payload is DeviceEventPayload {
  return typeof payload.name === "string" && (payload.data === undefined || isPlainObject(payload.data));
}

function isVoiceTranscriptPayload(payload: Record<string, unknown>): payload is VoiceTranscriptPayload {
  return (
    typeof payload.text === "string" &&
    payload.text.trim() !== "" &&
    (payload.wakeWord === undefined || typeof payload.wakeWord === "string")
  );
}

/** Parses and validates a message sent by a device to Core. */
export function parseDeviceToCoreMessage(raw: string): ParseResult<DeviceToCoreMessage> {
  const envelopeResult = parseEnvelopeShape(raw);
  if (!envelopeResult.ok) return envelopeResult;
  const envelope = envelopeResult.message;

  switch (envelope.type) {
    case "device.register": {
      // deviceId may legitimately be null here: a device's very first
      // registration attempt, before Core has confirmed its identity.
      if (!isDeviceRegisterPayload(envelope.payload)) {
        return { ok: false, reason: "Malformed device.register payload" };
      }
      return { ok: true, message: { ...envelope, type: "device.register", payload: envelope.payload } };
    }
    case "device.status": {
      const deviceIdResult = requireDeviceId(envelope);
      if (!deviceIdResult.ok) return deviceIdResult;
      if (!isDeviceStatusPayload(envelope.payload)) {
        return { ok: false, reason: "Malformed device.status payload" };
      }
      return {
        ok: true,
        message: { ...envelope, deviceId: deviceIdResult.message, type: "device.status", payload: envelope.payload },
      };
    }
    case "tool.result": {
      const deviceIdResult = requireDeviceId(envelope);
      if (!deviceIdResult.ok) return deviceIdResult;
      if (!isToolResultPayload(envelope.payload)) {
        return { ok: false, reason: "Malformed tool.result payload" };
      }
      return {
        ok: true,
        message: { ...envelope, deviceId: deviceIdResult.message, type: "tool.result", payload: envelope.payload },
      };
    }
    case "event": {
      const deviceIdResult = requireDeviceId(envelope);
      if (!deviceIdResult.ok) return deviceIdResult;
      if (!isDeviceEventPayload(envelope.payload)) {
        return { ok: false, reason: "Malformed event payload" };
      }
      return {
        ok: true,
        message: { ...envelope, deviceId: deviceIdResult.message, type: "event", payload: envelope.payload },
      };
    }
    case "pong": {
      const deviceIdResult = requireDeviceId(envelope);
      if (!deviceIdResult.ok) return deviceIdResult;
      return {
        ok: true,
        message: { ...envelope, deviceId: deviceIdResult.message, type: "pong", payload: {} },
      };
    }
    case "voice.transcript": {
      const deviceIdResult = requireDeviceId(envelope);
      if (!deviceIdResult.ok) return deviceIdResult;
      if (!isVoiceTranscriptPayload(envelope.payload)) {
        return { ok: false, reason: "Malformed voice.transcript payload" };
      }
      return {
        ok: true,
        message: { ...envelope, deviceId: deviceIdResult.message, type: "voice.transcript", payload: envelope.payload },
      };
    }
    default:
      return { ok: false, reason: `Unknown message type: ${envelope.type}` };
  }
}

function isToolRequestPayload(payload: Record<string, unknown>): payload is ToolRequestPayload {
  return typeof payload.tool === "string" && isPlainObject(payload.input);
}

function isDeviceCommandPayload(payload: Record<string, unknown>): payload is DeviceCommandPayload {
  return typeof payload.command === "string" && (payload.args === undefined || isPlainObject(payload.args));
}

function isVoiceReplyPayload(payload: Record<string, unknown>): payload is VoiceReplyPayload {
  return typeof payload.text === "string";
}

/** Parses and validates a message sent by Core to a device. */
export function parseCoreToDeviceMessage(raw: string): ParseResult<CoreToDeviceMessage> {
  const envelopeResult = parseEnvelopeShape(raw);
  if (!envelopeResult.ok) return envelopeResult;
  const envelope = envelopeResult.message;

  const deviceIdResult = requireDeviceId(envelope);
  if (!deviceIdResult.ok) return deviceIdResult;

  switch (envelope.type) {
    case "device.command":
      if (!isDeviceCommandPayload(envelope.payload)) {
        return { ok: false, reason: "Malformed device.command payload" };
      }
      return {
        ok: true,
        message: { ...envelope, deviceId: deviceIdResult.message, type: "device.command", payload: envelope.payload },
      };
    case "tool.request":
      if (!isToolRequestPayload(envelope.payload)) {
        return { ok: false, reason: "Malformed tool.request payload" };
      }
      return {
        ok: true,
        message: { ...envelope, deviceId: deviceIdResult.message, type: "tool.request", payload: envelope.payload },
      };
    case "ping":
      return {
        ok: true,
        message: { ...envelope, deviceId: deviceIdResult.message, type: "ping", payload: {} },
      };
    case "voice.reply":
      if (!isVoiceReplyPayload(envelope.payload)) {
        return { ok: false, reason: "Malformed voice.reply payload" };
      }
      return {
        ok: true,
        message: { ...envelope, deviceId: deviceIdResult.message, type: "voice.reply", payload: envelope.payload },
      };
    default:
      return { ok: false, reason: `Unknown message type: ${envelope.type}` };
  }
}

export function makeEnvelope<TType extends string, TPayload>(
  type: TType,
  payload: TPayload,
  deviceId: string | null,
  requestId: string
): Envelope<TType, TPayload> {
  return { requestId, timestamp: new Date().toISOString(), deviceId, type, payload };
}
