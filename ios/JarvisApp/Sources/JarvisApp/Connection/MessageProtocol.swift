// NEVER COMPILED OR RUN — no Xcode/iOS toolchain in this sandbox. Ported
// from agents/imac/JarvisAgent/Sources/JarvisAgent/Connection/MessageProtocol.swift,
// which is itself a Swift mirror of src/communication/websocket/protocol.ts.
// This file is almost a verbatim copy deliberately: the wire protocol is
// platform-agnostic (plain Foundation/Codable, nothing AppKit- or
// UIKit-specific lives here), so the iPhone app and the Mac agent must
// stay byte-for-byte compatible with the same Core, not grow two dialects
// of the same envelope. If you change this file, check whether the same
// change belongs in the Mac agent's copy too.
//
// The one deliberate difference from the Mac agent's copy: DeviceRegisterPayload's
// deviceType/platform are sent as "iphone"/"ios" here (src/types/devices.ts's
// DeviceType already includes "iphone" — confirmed by reading that file and
// protocol.ts's isDeviceRegisterPayload validator, which already accepts it;
// no Core-side change was needed for this).

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
    let deviceType: String // "iphone"
    let platform: String // "ios"
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
/// after "Hey JARVIS") — see VoiceController.swift for where this is
/// produced. Identical shape to the Mac agent's own payload; `wakeWord`
/// here doubles as this app's own "forced reply language" signal exactly
/// the same way (see VoiceController's doc comment).
struct VoiceTranscriptPayload: Codable {
    let text: String
    let wakeWord: String?
}

/// This app's live, self-reported permission status per capability — see
/// `PermissionsManager.swift` for how each value is determined. Each value
/// is one of "granted" | "denied" | "not_determined" | "restricted" |
/// "unsupported", matching `src/communication/websocket/protocol.ts`'s
/// `CapabilityStatus` union exactly (Core stores whatever string a device
/// sends without interpreting it — see `DeviceRegistry.updateCapabilities`).
struct DeviceCapabilitiesPayload: Codable {
    let permissions: [String: String]
}

/// Whatever (if anything) was captured during a proactive announcement's
/// reply window. See the Mac agent's identical struct — Core, not this
/// app, decides whether `text` authenticates as the owner.
struct ProactiveReplyPayload: Codable {
    let announcementId: String
    let text: String?
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

/// An unprompted, JARVIS-initiated announcement to speak aloud right now.
/// On this app specifically, this can only actually be delivered while the
/// app is foregrounded and connected — there is no background wake here
/// (see the app-level README's platform-constraint section) — so in
/// practice this fires far less reliably than on the always-on Mac agent
/// until a push-notification-triggered foreground launch is added, which
/// is NOT built in this first pass.
struct ProactiveAnnouncePayload: Codable {
    let text: String
    let announcementId: String
    let replyWindowMs: Int
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

/// Minimal `Codable` box for arbitrary JSON values — identical to the Mac
/// agent's own `AnyCodable`. Only used for encode/decode plumbing.
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
