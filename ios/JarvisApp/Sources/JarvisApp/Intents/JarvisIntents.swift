// NEVER COMPILED OR RUN — no Xcode/iOS toolchain in this sandbox. Written
// against the real, current App Intents framework API, confirmed via
// Apple's own current documentation ("Accelerating app interactions with
// App Intents") before writing this file: `AppIntent`'s `title`/
// `openAppWhenRun`/`perform()` shape and `AppShortcut(intent:phrases:
// shortTitle:systemImageName:)` with the `\(.applicationName)` phrase
// interpolation are all taken directly from Apple's own current example
// code, not reconstructed from memory of older SiriKit Intents.
//
// HONEST SCOPE NOTE (restated from this task's own instructions, worth
// repeating here at the exact point it matters): App Shortcuts only
// support a fixed, structured phrase with typed parameters — never
// open-ended free-form dictation passthrough. "Hey Siri, ask Jarvis to
// start listening" launches this app and puts it into listening mode; it
// cannot itself carry an arbitrary spoken question through to Core the way
// VoiceController's own wake-word capture does once the app is open. This
// is the realistic mitigation for "no true background wake-word" (see
// VoiceController.swift's header comment and the README), not a
// replacement for it — the Shortcut gets JARVIS listening quickly, it
// doesn't make listening happen with the app closed.

import AppIntents

/// Launches JarvisApp directly into a listening state — the App Intents
/// counterpart to saying "Hey Jarvis" out loud, for the one real gap a
/// phone's platform constraints create (no background wake-word).
/// `openAppWhenRun = true` brings the app to the foreground before
/// `perform()` runs, which is required here: `VoiceController` needs the
/// app foregrounded to use the microphone at all (see its own header
/// comment).
struct StartListeningIntent: AppIntent {
    static let title: LocalizedStringResource = "Start Listening"
    static let description = IntentDescription("Opens JARVIS and starts listening, the same as saying \"Hey Jarvis\" out loud while the app is open.")
    static let openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult {
        AppRuntimeState.shared.pendingStartListening = true
        return .result()
    }
}

/// Launches JarvisApp directly into the live camera view — the App
/// Intents counterpart to saying "open the camera" out loud, for the same
/// foreground-required reason as `StartListeningIntent`.
struct OpenCameraIntent: AppIntent {
    static let title: LocalizedStringResource = "Open Camera"
    static let description = IntentDescription("Opens JARVIS directly into the live camera view.")
    static let openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult {
        AppRuntimeState.shared.pendingOpenCamera = true
        return .result()
    }
}

/// Registers both intents as real Siri/Shortcuts phrases. Apple's own
/// documented example (see this file's header comment) is the direct
/// source for this shape — `\(.applicationName)` is a real, required
/// phrase-interpolation token so Siri can say the app's actual display
/// name regardless of locale, not a literal string to fill in by hand.
struct JarvisAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: StartListeningIntent(),
            phrases: [
                "Start listening in \(.applicationName)",
                "Hey \(.applicationName)",
            ],
            shortTitle: "Start Listening",
            systemImageName: "mic.fill"
        )
        AppShortcut(
            intent: OpenCameraIntent(),
            phrases: [
                "Open the camera in \(.applicationName)",
                "Show \(.applicationName) the camera",
            ],
            shortTitle: "Open Camera",
            systemImageName: "camera.fill"
        )
    }
}

/// Tiny shared flag bridge between an App Intent's `perform()` (which runs
/// outside any specific SwiftUI view's lifetime) and `RootView` (which
/// checks these flags on appear/foreground and clears them once handled).
/// Deliberately not a full event bus — two booleans is genuinely all this
/// needs today, and a heavier mechanism would be speculative for a first
/// pass with exactly two intents.
@MainActor
final class AppRuntimeState: ObservableObject {
    static let shared = AppRuntimeState()
    private init() {}

    @Published var pendingStartListening = false
    @Published var pendingOpenCamera = false
}
