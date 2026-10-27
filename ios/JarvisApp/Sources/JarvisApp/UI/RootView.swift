// NEVER COMPILED OR RUN — no Xcode/iOS toolchain in this sandbox. Written
// against SwiftUI's real, current Liquid Glass API — `glassEffect(_:in:)`
// and `GlassEffectContainer` — confirmed via Apple's own current
// documentation (developer.apple.com/documentation/swiftui/glasseffectcontainer,
// .../view/glasseffect(_:in:)) before writing this file, not reconstructed
// from memory of older iOS design patterns. This app's minimum deployment
// target is iOS 26.0 (see ../../project.yml) specifically so this file
// never needs an `#available`/legacy-Material fallback branch — a
// deliberate choice given David explicitly wants real Liquid Glass, not a
// backported approximation, and this is a brand-new app with no existing
// user base on older iOS to support.
//
// WHAT'S LITERALLY ON SCREEN (primary view): a full-bleed black background
// with the 3D Core (CoreRealityView) filling nearly the whole screen,
// dominant exactly as the task asks — no persistent chat/search bar
// anywhere in this view. A single small glass status pill floats near the
// top (safe-area-aware) showing connection state ("Connecting…",
// "Listening", "Thinking", "Reconnecting…") as plain text, Liquid-Glass-
// styled via `.glassEffect(.regular, in: Capsule())`. Near the bottom, a
// `GlassEffectContainer` holds two circular glass buttons side by side —
// a camera icon and a message/chat icon — the ONLY way to reach the
// camera or chat sheet manually (voice/App-Intent launch are the other
// two paths). Tapping the chat icon presents `ChatSheetView` as a sheet
// (not a push/full takeover) so the Core stays the dominant view
// whenever the sheet is dismissed. Tapping the camera icon presents
// `CameraSheetView` full-screen (a live camera feed deserves the whole
// screen, not a partial sheet). There is no persistent chat transcript
// visible anywhere in this view, by design — see ChatSheetView's own doc
// comment for what it's actually for.

import SwiftUI

struct RootView: View {
    @StateObject private var connectionManager: JarvisConnectionManager
    // SwiftUI's ObservableObject change notifications do NOT propagate
    // through a nested object automatically — `connectionManager`'s own
    // @Published properties would trigger a re-render, but
    // `connectionManager.voiceController`'s @Published properties (
    // isListening, isSpeaking, ...) would not, since voiceController
    // itself isn't a @Published property of JarvisConnectionManager.
    // Observing it directly here (constructed from the SAME instance
    // connectionManager owns — see init() below) is the standard, correct
    // SwiftUI fix for a nested ObservableObject.
    @ObservedObject private var voiceController: VoiceController
    @ObservedObject private var runtimeState = AppRuntimeState.shared
    @Environment(\.scenePhase) private var scenePhase

    @State private var showPairing = false
    @State private var showChatSheet = false
    @State private var showCameraSheet = false
    @State private var permissionsRequested = false

    init() {
        let manager = JarvisConnectionManager()
        _connectionManager = StateObject(wrappedValue: manager)
        _voiceController = ObservedObject(wrappedValue: manager.voiceController)
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            CoreRealityView(state: coreVisualState)
                .ignoresSafeArea()

            VStack {
                statusPill
                    .padding(.top, 8)
                Spacer()
                bottomControls
                    .padding(.bottom, 24)
            }
        }
        .onAppear(perform: handleAppear)
        .onChange(of: scenePhase) { oldPhase, newPhase in
            handleScenePhaseChange(oldPhase, newPhase)
        }
        .onChange(of: runtimeState.pendingStartListening) { _, pending in
            guard pending else { return }
            runtimeState.pendingStartListening = false
            voiceController.startListening()
        }
        .onChange(of: runtimeState.pendingOpenCamera) { _, pending in
            guard pending else { return }
            runtimeState.pendingOpenCamera = false
            showCameraSheet = true
        }
        .sheet(isPresented: $showPairing) {
            PairingView(connectionManager: connectionManager)
        }
        .sheet(isPresented: $showChatSheet) {
            ChatSheetView(connectionManager: connectionManager)
        }
        .fullScreenCover(isPresented: $showCameraSheet) {
            CameraSheetView(cameraController: connectionManager.cameraController)
        }
    }

    private var coreVisualState: CoreVisualState {
        var state = CoreVisualState()
        state.connected = connectionManager.connectionState == .connected
        state.listening = voiceController.isListening
        state.speaking = voiceController.isSpeaking
        return state
    }

    private var statusPill: some View {
        Text(statusText)
            .font(.footnote.weight(.medium))
            .foregroundStyle(.white)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .glassEffect(.regular, in: Capsule())
    }

    private var statusText: String {
        switch connectionManager.connectionState {
        case .disconnected: return "Not connected"
        case .connecting: return "Connecting…"
        case .awaitingPairingApproval(let code): return "Pairing: \(code)"
        case .connected: return voiceController.isListening ? "Listening" : "Connected"
        case .reconnecting: return "Reconnecting…"
        }
    }

    private var bottomControls: some View {
        GlassEffectContainer {
            HStack(spacing: 20) {
                Button {
                    showCameraSheet = true
                } label: {
                    Image(systemName: "camera.fill")
                        .font(.title3)
                        .foregroundStyle(.white)
                        .frame(width: 52, height: 52)
                }
                .glassEffect(.regular.interactive(), in: Circle())

                Button {
                    showChatSheet = true
                } label: {
                    Image(systemName: "message.fill")
                        .font(.title3)
                        .foregroundStyle(.white)
                        .frame(width: 52, height: 52)
                }
                .glassEffect(.regular.interactive(), in: Circle())
            }
        }
    }

    private func handleAppear() {
        guard !permissionsRequested else { return }
        permissionsRequested = true
        // Standard one-time permission prompts, requested once at first
        // use — exactly the task's own instructions, matching how the web
        // Voice Mode and the Mac agent's WakeWordListener already do this.
        voiceController.requestPermissionsIfNeeded { _ in }

        if let storedURL = connectionManager.storedCoreURL {
            connectionManager.connect(to: storedURL)
        } else {
            showPairing = true
        }
    }

    private func handleScenePhaseChange(_ oldPhase: ScenePhase, _ newPhase: ScenePhase) {
        switch newPhase {
        case .active:
            if connectionManager.connectionState == .connected, !showCameraSheet {
                voiceController.startListening()
            }
        case .inactive, .background:
            // Foreground-only listening — see VoiceController.swift's
            // header comment on why this can't continue in the
            // background at all.
            voiceController.stopListening()
        @unknown default:
            break
        }
    }
}
