// REQUIRES REAL macOS VALIDATION — never compiled or run in this
// environment (no Xcode/macOS SDK available). This wires the pieces
// together as designed; it has not been proven to actually build or run.

import AppKit
import Foundation

final class JarvisAgentApp: NSObject, NSApplicationDelegate, CoreConnectionDelegate {
    private let deviceId = DeviceIdentity.loadOrCreate()
    private let tools = AgentToolRegistry.buildDefault()
    private let statusBar = StatusItemController()
    private var connection: CoreConnection!

    // Configure via environment/config in a real build; hardcoded here only
    // as a placeholder for the source structure.
    private let coreURL = URL(string: "wss://localhost:4770")!

    func applicationDidFinishLaunching(_ notification: Notification) {
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
        statusBar.update(status: .connected)
        register()
    }

    func coreConnectionDidClose(_ connection: CoreConnection, error: Error?) {
        statusBar.update(status: .reconnecting)
    }

    func coreConnection(_ connection: CoreConnection, didReceive envelopeData: Data) {
        // A real implementation decodes the envelope's `type` and routes:
        // - "tool.request" -> AgentToolRegistry.execute, then send tool.result
        // - "device.command" (pairing.pending/pairing.approved) -> update UI /
        //   persist credential via KeychainStore
        // - "ping" -> reply "pong"
        // Deliberately not fleshed out further here: doing so without a real
        // macOS runtime to validate JSON decoding, threading, and NSWorkspace
        // behavior would risk shipping unverified logic as if it were tested.
        Logger.shared.log("Received \(envelopeData.count) bytes from Core")
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

        let envelope = MessageFactory.makeEnvelope(
            type: "device.register",
            payload: payload,
            deviceId: credential != nil ? deviceId : nil
        )

        guard let data = try? JSONEncoder().encode(envelope) else { return }
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
