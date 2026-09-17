// Builds successfully with `swift build` on a real Mac (verified). Runtime
// behavior below — pairing, tool execution, Keychain — is still unverified
// end to end; validate each step against a running JARVIS Core before
// trusting it.

import AppKit
import Foundation

final class JarvisAgentApp: NSObject, NSApplicationDelegate, CoreConnectionDelegate {
    private let deviceId = DeviceIdentity.loadOrCreate()
    private let tools = AgentToolRegistry.buildDefault()
    private let statusBar = StatusItemController()
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

        default:
            Logger.shared.log("Unhandled device.command: \(envelope.payload.command)")
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
