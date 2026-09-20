// Builds successfully with `swift build` on a real Mac (verified). Runtime
// behavior below — pairing, tool execution, Keychain — is still unverified
// end to end; validate each step against a running JARVIS Core before
// trusting it.

import AppKit
import Foundation
import UserNotifications

final class JarvisAgentApp: NSObject, NSApplicationDelegate, CoreConnectionDelegate {
    private let deviceId = DeviceIdentity.loadOrCreate()
    private let tools = AgentToolRegistry.buildDefault()
    private let statusBar = StatusItemController()
    private let wakeWordListener = WakeWordListener()
    private var connection: CoreConnection!

    // JARVIS Core (Bun.serve) speaks plain WebSocket, not TLS, so this
    // defaults to ws:// — wss:// would fail to connect. Override with
    // JARVIS_CORE_URL for a non-default host/port.
    private let coreURL = URL(
        string: ProcessInfo.processInfo.environment["JARVIS_CORE_URL"] ?? "ws://localhost:4770"
    )!

    func applicationDidFinishLaunching(_ notification: Notification) {
        print("[JarvisAgent] Starting. deviceId=\(deviceId)")
        connection = CoreConnection(coreURL: coreURL)
        connection.delegate = self

        statusBar.onPairRequested = { [weak self] in
            self?.register()
        }
        statusBar.onQuitRequested = {
            NSApplication.shared.terminate(nil)
        }

        wakeWordListener.onTranscriptReady = { [weak self] text, language in
            self?.sendVoiceTranscript(text, forcedLanguage: language)
        }
        wakeWordListener.start()

        // Native notification permission — needed for show_notification
        // (due reminders, automation results) to actually appear as a
        // banner, independent of Telegram being configured at all.
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, error in
            if let error {
                Logger.shared.log("Notification authorization request failed: \(error.localizedDescription)")
            } else if !granted {
                Logger.shared.log("Notification permission not granted — show_notification will silently do nothing.")
            }
        }

        connection.connect()
    }

    func coreConnectionDidOpen(_ connection: CoreConnection) {
        print("[JarvisAgent] Connected to Core. Registering...")
        statusBar.update(status: .connected)
        register()
    }

    func coreConnectionDidClose(_ connection: CoreConnection, error: Error?) {
        statusBar.update(status: .reconnecting)
    }

    func coreConnection(_ connection: CoreConnection, didReceive envelopeData: Data) {
        guard let header = try? JSONDecoder().decode(EnvelopeHeader.self, from: envelopeData) else {
            Logger.shared.log("Failed to decode envelope header")
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
        default:
            Logger.shared.log("Unhandled message type: \(header.type)")
        }
    }

    private func handleDeviceCommand(data: Data) {
        guard let envelope = try? JSONDecoder().decode(Envelope<DeviceCommandPayload>.self, from: data) else {
            Logger.shared.log("Failed to decode device.command payload")
            return
        }

        switch envelope.payload.command {
        case "pairing.pending":
            guard
                let args = envelope.payload.args,
                let code = args["code"]?.value as? String
            else {
                Logger.shared.log("pairing.pending received with no code")
                return
            }
            // Printed directly (not just logged) so it's visible in the
            // terminal running this executable, without needing Console.app.
            print("""

            ==================================================
             JARVIS pairing code: \(code)
             Approve it from the Core machine with:
               bun run approve-device \(deviceId) \(code)
            ==================================================

            """)
            Logger.shared.log("Pairing code received for device \(deviceId)")

        case "pairing.approved":
            if let credential = envelope.payload.args?["credential"]?.value as? String {
                let saved = KeychainStore.saveCredential(credential)
                print(saved ? "[JarvisAgent] Paired — credential saved to Keychain." : "[JarvisAgent] Paired, but failed to save credential to Keychain.")
            } else {
                print("[JarvisAgent] Registration approved (reconnected with an existing credential).")
            }
            statusBar.update(status: .connected, deviceName: Host.current().localizedName)

        case "show_notification":
            let title = (envelope.payload.args?["title"]?.value as? String) ?? "JARVIS"
            let body = (envelope.payload.args?["body"]?.value as? String) ?? ""
            showNotification(title: title, body: body)

        default:
            Logger.shared.log("Unhandled device.command: \(envelope.payload.command)")
        }
    }

    /// Posts a native macOS notification banner — the on-device push
    /// counterpart to Telegram's NOTIFY_USER, for when the user hasn't
    /// (or hasn't yet) connected Telegram at all. Silently does nothing if
    /// notification permission was never granted (see the authorization
    /// request in applicationDidFinishLaunching) — the same best-effort
    /// posture as every other push channel in this codebase.
    private func showNotification(title: String, body: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { error in
            if let error {
                Logger.shared.log("Failed to post notification: \(error.localizedDescription)")
            }
        }
    }

    private func handleToolRequest(data: Data) {
        guard let envelope = try? JSONDecoder().decode(Envelope<ToolRequestPayload>.self, from: data) else {
            Logger.shared.log("Failed to decode tool.request payload")
            return
        }

        let result = tools.execute(name: envelope.payload.tool, input: envelope.payload.input)

        let resultEnvelope = MessageFactory.makeEnvelope(
            type: "tool.result",
            payload: result,
            deviceId: deviceId,
            requestId: envelope.requestId
        )

        guard let resultData = try? JSONEncoder().encode(resultEnvelope) else {
            Logger.shared.log("Failed to encode tool.result")
            return
        }
        connection.send(data: resultData)
    }

    private func sendPong() {
        let envelope = MessageFactory.makeEnvelope(type: "pong", payload: EmptyPayload(), deviceId: deviceId)
        guard let data = try? JSONEncoder().encode(envelope) else { return }
        connection.send(data: data)
    }

    /// Sends a wake-word-triggered voice command to Core, once the "Hey
    /// JARVIS" listener has captured what followed the wake phrase.
    /// `forcedLanguage` carries which wake phrase was used — "en"/"he" — so
    /// Core can force the reply's language instead of only auto-detecting
    /// it from the command text; "" (a clap-triggered command has no wake
    /// phrase to read a language from) leaves auto-detection in place.
    private func sendVoiceTranscript(_ text: String, forcedLanguage: String) {
        let envelope = MessageFactory.makeEnvelope(
            type: "voice.transcript",
            payload: VoiceTranscriptPayload(text: text, wakeWord: forcedLanguage.isEmpty ? nil : forcedLanguage),
            deviceId: deviceId
        )
        guard let data = try? JSONEncoder().encode(envelope) else {
            Logger.shared.log("Failed to encode voice.transcript")
            return
        }
        connection.send(data: data)
    }

    /// Speaks a reply from Core back to the user — the other half of a "Hey JARVIS" round trip.
    private func handleVoiceReply(data: Data) {
        guard let envelope = try? JSONDecoder().decode(Envelope<VoiceReplyPayload>.self, from: data) else {
            Logger.shared.log("Failed to decode voice.reply payload")
            return
        }
        wakeWordListener.speak(envelope.payload.text)
    }

    private func register() {
        let credential = KeychainStore.loadCredential()

        let payload = DeviceRegisterPayload(
            deviceName: Host.current().localizedName ?? "iMac",
            deviceType: "mac",
            platform: "macos",
            agentVersion: "0.1.0",
            protocolVersion: protocolVersion,
            capabilities: ["get_active_application"],
            requestedRole: "primary",
            credential: credential
        )

        // Always send our own persisted deviceId, even before pairing is
        // approved — otherwise Core would mint a fresh random id (and a
        // fresh pairing code) on every reconnect attempt while waiting for
        // approval, since it falls back to a random id only when deviceId
        // is null.
        let envelope = MessageFactory.makeEnvelope(
            type: "device.register",
            payload: payload,
            deviceId: deviceId
        )

        guard let data = try? JSONEncoder().encode(envelope) else {
            print("[JarvisAgent] Failed to encode device.register envelope")
            return
        }
        print("[JarvisAgent] Sending device.register (deviceId=\(deviceId), hasCredential=\(credential != nil))")
        connection.send(data: data)
    }
}

let app = NSApplication.shared
let delegate = JarvisAgentApp()
app.delegate = delegate
// LSUIElement (set in Info.plist for a packaged app) keeps this out of the
// Dock; .accessory achieves the same when run as a raw executable.
app.setActivationPolicy(.accessory)
app.run()
