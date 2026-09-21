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
            reportCapabilities()

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

        // Crash recovery (roadmap #68): a tool implementation throwing an
        // unexpected Swift error must become a failed tool.result Core can
        // see and report on, never an uncaught error that takes down the
        // whole Agent process — the same posture Core's own
        // uncaughtException/unhandledRejection handlers give the
        // TypeScript side (see src/index.ts). AgentTool.execute itself is
        // non-throwing by signature (see ToolRegistry.swift), so this
        // catches only what Swift's type system can express catching —
        // note in the README/audit that a genuine runtime trap (force
        // unwrap of nil, array out-of-bounds, integer overflow) is NOT
        // something `do`/`catch` can intercept in Swift; those remain a
        // real, unaddressed crash risk that only careful auditing of each
        // tool's own force-unwraps (none found by inspection today — see
        // JARVIS_ROADMAP_AUDIT.md) and eventual launchd `KeepAlive`
        // auto-restart (Resources/com.jarvis.agent.plist, already in
        // place) can mitigate.
        let result: ToolResultPayload
        do {
            result = try runToolCatchingErrors(name: envelope.payload.tool, input: envelope.payload.input)
        } catch {
            Logger.shared.error("Tool \(envelope.payload.tool) threw: \(error.localizedDescription)")
            result = ToolResultPayload(success: false, data: nil, error: "Tool execution failed: \(error.localizedDescription)")
        }

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

    /// Thin `throws`-bridging wrapper around `AgentToolRegistry.execute` —
    /// `AgentTool.execute` closures are non-throwing today, but this keeps
    /// the call site inside a real `do`/`catch` so a future tool that
    /// legitimately needs to `throw` (rather than returning a failed
    /// `ToolResultPayload` itself) is automatically covered by the same
    /// crash-recovery path instead of requiring every future tool author
    /// to remember to wrap their own call site.
    private func runToolCatchingErrors(name: String, input: [String: AnyCodable]) throws -> ToolResultPayload {
        tools.execute(name: name, input: input)
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

    /// Sends this Agent's live permission status to Core (capability
    /// discovery / permission status — roadmap #79/#80). Called once
    /// pairing is confirmed (there's no authenticated connection to send
    /// on before that); `WakeWordListener` requests mic/speech access on
    /// launch independently of this, so by the time pairing usually
    /// completes those prompts may already be resolved one way or another.
    private func reportCapabilities() {
        CapabilityReporter.currentPermissions { [weak self] permissions in
            guard let self else { return }
            let envelope = MessageFactory.makeEnvelope(
                type: "device.capabilities",
                payload: DeviceCapabilitiesPayload(permissions: permissions),
                deviceId: self.deviceId
            )
            guard let data = try? JSONEncoder().encode(envelope) else {
                Logger.shared.log("Failed to encode device.capabilities")
                return
            }
            print("[JarvisAgent] Reporting capabilities: \(permissions)")
            self.connection.send(data: data)
        }
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

// Crash recovery, part 2 (roadmap #68): logs an uncaught Objective-C/
// AppKit exception (the kind many Cocoa APIs — including some EventKit/
// UserNotifications paths this Agent calls into — raise instead of
// throwing a Swift `Error`) before the process terminates, so a crash at
// least leaves a diagnosable line in both OSLog and this log file rather
// than nothing. This is NOT a general crash preventer: it cannot catch a
// Swift-level runtime trap (force unwrap of nil, array out-of-bounds,
// division by zero, `fatalError`) — those remain fatal by design in
// Swift and were not found in this codebase by inspection (see
// JARVIS_ROADMAP_AUDIT.md's update for #68). The actual process-level
// recovery for any crash this can't prevent is `launchd`'s own
// `KeepAlive` (Resources/com.jarvis.agent.plist), which restarts the
// Agent automatically — this handler only makes *why* it crashed
// possible to find afterward.
NSSetUncaughtExceptionHandler { exception in
    let message = "Uncaught exception: \(exception.name.rawValue) — \(exception.reason ?? "no reason") — \(exception.callStackSymbols.joined(separator: "\n"))"
    Logger.shared.error(message)
    print("[JarvisAgent] FATAL: \(message)")
}

let app = NSApplication.shared
let delegate = JarvisAgentApp()
app.delegate = delegate
// LSUIElement (set in Info.plist for a packaged app) keeps this out of the
// Dock; .accessory achieves the same when run as a raw executable.
app.setActivationPolicy(.accessory)
app.run()
