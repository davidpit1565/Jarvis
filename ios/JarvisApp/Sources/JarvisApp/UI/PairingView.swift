// NEVER COMPILED OR RUN — no Xcode/iOS toolchain in this sandbox.
//
// Device pairing, following the SAME real flow the Mac agent and
// Core already implement — this view does NOT invent a new auth
// mechanism. The sequence (read `src/devices/pairing/PairingService.ts`
// and `JarvisWebSocketServer.ts`'s `handleApproveHttp` for the
// authoritative Core-side version):
//   1. This app sends `device.register` with no stored credential.
//   2. Core replies with `device.command` { command: "pairing.pending",
//      args: { code } } — a short pairing code.
//   3. A human runs `bun run approve-device <deviceId> <code>` (or the
//      admin panel's equivalent) on the Core machine.
//   4. Core sends `device.command` { command: "pairing.approved",
//      args: { credential } } — this app saves `credential` to the
//      Keychain via `KeychainStore` and is paired from then on.
// This view's only real job is (a) collecting the Core URL once, and
// (b) displaying the pairing code `JarvisConnectionManager` already
// receives and stores in `connectionState` — all the actual protocol
// logic lives in `JarvisConnectionManager`/`CoreConnection`, not here.
//
// WHAT'S LITERALLY ON SCREEN: a single glass card with a text field for
// the Core's WebSocket URL (e.g. "ws://192.168.1.50:4770" or a real
// "wss://jarvis.example.com" Fly deployment), a "Connect" button, and —
// once a pairing code arrives — that code displayed large and
// selectable, with a one-line instruction to run `bun run approve-device`
// on the Core machine. Dismisses itself automatically once
// `connectionState` becomes `.connected`.

import SwiftUI

struct PairingView: View {
    @ObservedObject var connectionManager: JarvisConnectionManager
    @Environment(\.dismiss) private var dismiss

    @State private var urlText = "ws://localhost:4770"

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                Spacer()

                Text("Connect to JARVIS")
                    .font(.title2.bold())
                    .foregroundStyle(.white)

                VStack(alignment: .leading, spacing: 8) {
                    Text("Core WebSocket URL")
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.7))
                    TextField("ws://host:4770", text: $urlText)
                        .textFieldStyle(.plain)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .padding(12)
                        .foregroundStyle(.white)
                        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 14))
                }
                .padding(.horizontal, 32)

                switch connectionManager.connectionState {
                case .awaitingPairingApproval(let code):
                    VStack(spacing: 8) {
                        Text("Pairing code")
                            .font(.caption)
                            .foregroundStyle(.white.opacity(0.7))
                        Text(code)
                            .font(.system(.largeTitle, design: .monospaced).bold())
                            .foregroundStyle(.white)
                            .textSelection(.enabled)
                        Text("Run on the Core machine:\nbun run approve-device <deviceId> \(code)")
                            .font(.caption)
                            .multilineTextAlignment(.center)
                            .foregroundStyle(.white.opacity(0.6))
                    }
                    .padding()
                    .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 18))
                    .padding(.horizontal, 32)

                case .connecting, .reconnecting:
                    ProgressView()
                        .tint(.white)

                default:
                    Button("Connect") {
                        if let url = URL(string: urlText) {
                            connectionManager.connect(to: url)
                        }
                    }
                    .buttonStyle(.glassProminent)
                    .disabled(urlText.trimmingCharacters(in: .whitespaces).isEmpty)
                }

                Spacer()
            }
            .background(Color.black)
        }
        .onChange(of: connectionManager.connectionState) { _, newState in
            if newState == .connected {
                dismiss()
            }
        }
    }
}
