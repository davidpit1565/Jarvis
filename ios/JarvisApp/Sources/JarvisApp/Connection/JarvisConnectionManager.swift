// NEVER COMPILED OR RUN — no Xcode/iOS toolchain in this sandbox. The
// SwiftUI-facing counterpart to the Mac agent's `JarvisAgentApp` (its
// `main.swift`) — same message dispatch, same pairing flow, restructured
// as an `ObservableObject` so SwiftUI views can bind to connection state
// directly instead of a status-bar controller.

import AVFAudio
import Combine
import Foundation
import Speech
import SwiftUI
import UIKit

enum ConnectionState: Equatable {
    case disconnected
    case connecting
    case awaitingPairingApproval(code: String)
    case connected
    case reconnecting
}

@MainActor
final class JarvisConnectionManager: NSObject, ObservableObject, CoreConnectionDelegate {
    @Published private(set) var connectionState: ConnectionState = .disconnected
    @Published private(set) var lastAssistantReply: String?

    let deviceId = DeviceIdentity.loadOrCreate()
    let cameraController = CameraController()
    let voiceController = VoiceController()
    private lazy var tools = AgentToolRegistry.buildDefault(cameraController: cameraController)

    private var connection: CoreConnection?
    /// Persisted across launches (UserDefaults, not a secret) so re-pairing
    /// isn't required every time the Core URL is the same — distinct from
    /// `KeychainStore`'s credential, which IS the secret.
    private let coreURLDefaultsKey = "jarvis.coreURL"

    override init() {
        super.init()
        voiceController.onTranscriptReady = { [weak self] text, language in
            self?.sendVoiceTranscript(text, forcedLanguage: language)
        }
    }

    var storedCoreURL: URL? {
        guard let raw = UserDefaults.standard.string(forKey: coreURLDefaultsKey) else { return nil }
        return URL(string: raw)
    }

    /// Starts (or restarts) the connection to a given Core URL — called
    /// from `PairingView` the first time, and automatically on subsequent
    /// launches using the remembered URL.
    func connect(to coreURL: URL) {
        UserDefaults.standard.set(coreURL.absoluteString, forKey: coreURLDefaultsKey)
        connection?.stop()
        connectionState = .connecting
        let newConnection = CoreConnection(coreURL: coreURL)
        newConnection.delegate = self
        connection = newConnection
        newConnection.connect()
    }

    func coreConnectionDidOpen(_ connection: CoreConnection) {
        register()
    }

    func coreConnectionDidClose(_ connection: CoreConnection, error: Error?) {
        connectionState = .reconnecting
    }

    func coreConnection(_ connection: CoreConnection, didReceive envelopeData: Data) {
        guard let header = try? JSONDecoder().decode(EnvelopeHeader.self, from: envelopeData) else {
            Logger.error("Failed to decode envelope header")
            return
        }

        switch header.type {
        case "device.command":
            handleDeviceCommand(data: envelopeData)
        case "tool.request":
            handleToolRequest(data: envelopeData)
        case "ping":
            sendPong()
        case "voice.reply":
            handleVoiceReply(data: envelopeData)
        case "proactive.announce":
            handleProactiveAnnounce(data: envelopeData)
        default:
            Logger.log("Unhandled message type: \(header.type)")
        }
    }

    private func handleDeviceCommand(data: Data) {
        guard let envelope = try? JSONDecoder().decode(Envelope<DeviceCommandPayload>.self, from: data) else {
            Logger.error("Failed to decode device.command payload")
            return
        }

        switch envelope.payload.command {
        case "pairing.pending":
            guard let args = envelope.payload.args, let code = args["code"]?.value as? String else { return }
            connectionState = .awaitingPairingApproval(code: code)
            Logger.log("Pairing code received: \(code)")

        case "pairing.approved":
            if let credential = envelope.payload.args?["credential"]?.value as? String {
                _ = KeychainStore.saveCredential(credential)
            }
            connectionState = .connected
            reportCapabilities()

        default:
            Logger.log("Unhandled device.command: \(envelope.payload.command)")
        }
    }

    private func handleToolRequest(data: Data) {
        guard let envelope = try? JSONDecoder().decode(Envelope<ToolRequestPayload>.self, from: data) else {
            Logger.error("Failed to decode tool.request payload")
            return
        }

        let result = tools.execute(name: envelope.payload.tool, input: envelope.payload.input)
        let resultEnvelope = MessageFactory.makeEnvelope(
            type: "tool.result",
            payload: result,
            deviceId: deviceId,
            requestId: envelope.requestId
        )
        guard let resultData = try? JSONEncoder().encode(resultEnvelope) else { return }
        connection?.send(data: resultData)
    }

    private func sendPong() {
        let envelope = MessageFactory.makeEnvelope(type: "pong", payload: EmptyPayload(), deviceId: deviceId)
        guard let data = try? JSONEncoder().encode(envelope) else { return }
        connection?.send(data: data)
    }

    private func sendVoiceTranscript(_ text: String, forcedLanguage: String) {
        let envelope = MessageFactory.makeEnvelope(
            type: "voice.transcript",
            payload: VoiceTranscriptPayload(text: text, wakeWord: forcedLanguage.isEmpty ? nil : forcedLanguage),
            deviceId: deviceId
        )
        guard let data = try? JSONEncoder().encode(envelope) else { return }
        connection?.send(data: data)
    }

    private func handleVoiceReply(data: Data) {
        guard let envelope = try? JSONDecoder().decode(Envelope<VoiceReplyPayload>.self, from: data) else { return }
        lastAssistantReply = envelope.payload.text
        voiceController.speak(envelope.payload.text)
    }

    private func handleProactiveAnnounce(data: Data) {
        // NOTE: can only ever actually fire while this app is foregrounded
        // and connected — see VoiceController.swift's header comment and
        // the README's platform-constraint section. There is no push-
        // notification-triggered foreground launch wired up in this first
        // pass to make this more reliable; a due/urgent proactive
        // announcement should still go out over Telegram/phone (channels
        // that already work regardless of this app's state), not rely on
        // this path.
        guard let envelope = try? JSONDecoder().decode(Envelope<ProactiveAnnouncePayload>.self, from: data) else { return }
        let announcementId = envelope.payload.announcementId
        lastAssistantReply = envelope.payload.text
        voiceController.speak(envelope.payload.text)
        // This app does not yet implement the no-wake-phrase reply-capture
        // window the Mac agent's speakProactiveAnnouncement has — reports
        // "nothing heard" immediately rather than silently dropping the
        // message Core is waiting on. A real capture window is a
        // reasonable, small follow-up (VoiceController already has all the
        // recognition plumbing needed; see its speakProactiveAnnouncement-
        // equivalent as a TODO), just not built in this first pass.
        let replyEnvelope = MessageFactory.makeEnvelope(
            type: "proactive.reply",
            payload: ProactiveReplyPayload(announcementId: announcementId, text: nil),
            deviceId: deviceId
        )
        guard let data = try? JSONEncoder().encode(replyEnvelope) else { return }
        connection?.send(data: data)
    }

    private func reportCapabilities() {
        // Mirrors the Mac agent's CapabilityReporter, but far simpler:
        // this app only cares about microphone/speech/camera, and (unlike
        // the Mac agent's many TCC-mediated permissions) iOS exposes these
        // as plain, synchronously-readable enums.
        var permissions: [String: String] = [:]
        permissions["microphone"] = mapAVAudioApplicationPermission()
        permissions["speech_recognition"] = mapSpeechPermission()
        permissions["camera"] = mapCameraPermission()

        let envelope = MessageFactory.makeEnvelope(
            type: "device.capabilities",
            payload: DeviceCapabilitiesPayload(permissions: permissions),
            deviceId: deviceId
        )
        guard let data = try? JSONEncoder().encode(envelope) else { return }
        connection?.send(data: data)
    }

    private func mapSpeechPermission() -> String {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: return "granted"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "not_determined"
        @unknown default: return "unsupported"
        }
    }

    /// `AVAudioApplication.shared.recordPermission` is the current (iOS 17+)
    /// replacement for the deprecated `AVAudioSession.recordPermission` —
    /// same API family as the `requestRecordPermission` call in
    /// `VoiceController.swift`, confirmed against Apple's own current
    /// documentation before writing this.
    private func mapAVAudioApplicationPermission() -> String {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return "granted"
        case .denied: return "denied"
        case .undetermined: return "not_determined"
        @unknown default: return "unsupported"
        }
    }

    private func mapCameraPermission() -> String {
        switch cameraController.permissionState {
        case .granted: return "granted"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "not_determined"
        }
    }

    private func register() {
        let credential = KeychainStore.loadCredential()
        let payload = DeviceRegisterPayload(
            deviceName: UIDevice.current.name,
            deviceType: "iphone",
            platform: "ios",
            agentVersion: "0.1.0",
            protocolVersion: protocolVersion,
            capabilities: tools.toolNames,
            requestedRole: "mobile",
            credential: credential
        )
        let envelope = MessageFactory.makeEnvelope(type: "device.register", payload: payload, deviceId: deviceId)
        guard let data = try? JSONEncoder().encode(envelope) else { return }
        connection?.send(data: data)
    }
}
