// REQUIRES REAL macOS VALIDATION — written against the Phase 2 TypeScript
// protocol (src/communication/websocket/protocol.ts) but never compiled.
//
// Swift mirror of the Core <-> device envelope protocol. Every message is
// wrapped the same way regardless of direction; `deviceId` is only ever
// nil on this agent's very first `device.register` before Core has
// confirmed its identity.

import Foundation

let protocolVersion = "1"

struct Envelope<Payload: Codable>: Codable {
    let requestId: String
    let timestamp: String
    let deviceId: String?
    let type: String
    let payload: Payload
}

/// Decodes just the envelope's routing fields, ignoring `payload` (whose
/// shape depends on `type`). Used to decide which concrete `Envelope<...>`
/// to decode next.
struct EnvelopeHeader: Codable {
    let requestId: String
    let timestamp: String
    let deviceId: String?
    let type: String
}

// MARK: - Device -> Core payloads

struct DeviceRegisterPayload: Codable {
    let deviceName: String
    let deviceType: String // "mac"
    let platform: String // "macos"
    let agentVersion: String
    let protocolVersion: String
    let capabilities: [String]
    let requestedRole: String? // "primary" | "secondary" | "mobile"
    let credential: String?
}

struct DeviceStatusPayload: Codable {
    let status: String // "online" | "offline" | "unknown"
}

struct ToolResultPayload: Codable {
    let success: Bool
    let data: AnyCodable?
    let error: String?
}

struct DeviceEventPayload: Codable {
    let name: String
    let data: [String: AnyCodable]?
}

struct EmptyPayload: Codable {}

/// A wake-word-triggered voice command transcribed on-device (the text
/// after "Hey JARVIS") — see WakeWordListener.swift for where this is
/// produced.
struct VoiceTranscriptPayload: Codable {
    let text: String
    let wakeWord: String?
}

// MARK: - Core -> Device payloads

struct ToolRequestPayload: Codable {
    let tool: String
    let input: [String: AnyCodable]
}

struct DeviceCommandPayload: Codable {
    let command: String
    let args: [String: AnyCodable]?
}

/// The spoken-back reply to a voice.transcript, to be read aloud via
/// AVSpeechSynthesizer.
struct VoiceReplyPayload: Codable {
    let text: String
}

// MARK: - Helpers for constructing outbound messages

enum MessageFactory {
    static func makeEnvelope<Payload: Codable>(
        type: String,
        payload: Payload,
        deviceId: String?,
        requestId: String = UUID().uuidString
    ) -> Envelope<Payload> {
        Envelope(
            requestId: requestId,
            timestamp: ISO8601DateFormatter().string(from: Date()),
            deviceId: deviceId,
            type: type,
            payload: payload
        )
    }
}

/// Minimal `Codable` box for arbitrary JSON values, since a tool's `input`/`data`
/// is opaque to the protocol layer. Only used for encode/decode plumbing — never
/// interpreted here (the tool implementation itself knows its own shape).
struct AnyCodable: Codable {
    let value: Any

    init(_ value: Any) { self.value = value }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let v = try? container.decode(Bool.self) { value = v; return }
        if let v = try? container.decode(Double.self) { value = v; return }
        if let v = try? container.decode(String.self) { value = v; return }
        if let v = try? container.decode([String: AnyCodable].self) { value = v; return }
        if let v = try? container.decode([AnyCodable].self) { value = v; return }
        value = NSNull()
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch value {
        case let v as Bool: try container.encode(v)
        case let v as Double: try container.encode(v)
        case let v as Int: try container.encode(v)
        case let v as String: try container.encode(v)
        case let v as [String: AnyCodable]: try container.encode(v)
        case let v as [AnyCodable]: try container.encode(v)
        default: try container.encodeNil()
        }
    }
}
