// REQUIRES REAL macOS VALIDATION — NSEvent global monitors, Accessibility
// trust, and real key-code/modifier matching cannot be exercised outside a
// real macOS runtime with Accessibility access granted. Never compiled or
// run in this environment.

import AppKit

/// A single, fixed global keyboard shortcut that does exactly what saying
/// "Hey JARVIS, look at my screen" does — a hands-on alternative to the
/// hands-free wake phrase in `WakeWordListener`, for the moments typing a
/// key is faster/quieter than speaking (open-plan office, a call in
/// progress, voice recognition having a bad day on background noise).
///
/// This listener does NOT capture a screenshot or talk to any vision
/// model itself — that pipeline (the `LOOK_AT_SCREEN` device tool and the
/// orchestrator wiring that gets a captured image to a vision-capable
/// model) is a separate, concurrently-developed piece of work. This
/// listener's only job is the trigger: turn one key chord into the same
/// `voice.transcript` message `WakeWordListener` already sends Core for a
/// spoken command, with a fixed stand-in phrase instead of a live
/// transcription. Core's own model then decides what to do with that
/// phrase — including, once the other work lands, calling `LOOK_AT_SCREEN`
/// — exactly as it would for anything spoken aloud. See
/// `JarvisAgentApp.sendVoiceTranscript` in `main.swift`, which both this
/// listener and `WakeWordListener` call into: no second WebSocket-sending
/// code path was created for this.
///
/// ## Why `NSEvent.addGlobalMonitorForEvents`, not Carbon's
/// `RegisterEventHotKey`
///
/// Carbon's `RegisterEventHotKey`/`InstallEventHandler` (HIToolbox) is the
/// older API and is sometimes cited for not needing Accessibility access
/// for a single fixed combo — but it is a deprecated C API with no Swift
/// overlay, awkward to call correctly from Swift, and not what Apple's own
/// current documentation points new code toward. `NSEvent
/// .addGlobalMonitorForEvents(matching:handler:)` is the documented,
/// actively-maintained AppKit API for observing events from other
/// applications, and is what this project already effectively depends on
/// for its other system-wide interaction tools
/// (`ClickElementTool`/`TypeText` — see `FileAccessPolicy`-adjacent
/// `CapabilityReporter.requestAccessibilityIfNeeded()` in
/// `Identity/CapabilityReporter.swift`). Apple's own documentation for
/// global monitors is explicit that `keyDown`/`keyUp`/`flagsChanged`
/// events are only delivered to a global monitor when the app is trusted
/// for Accessibility — the same one-time grant this Agent already
/// requests at launch for its other device-control tools, not a new,
/// separate permission to explain to David. That makes
/// `NSEvent.addGlobalMonitorForEvents` the better fit here: no new
/// framework, no new permission story, consistent with how every other
/// "control the Mac itself" feature in this Agent already works.
///
/// `AXIsProcessTrusted()` is only used here to decide what to log, not to
/// gate registration: the monitor is always installed. If Accessibility
/// isn't granted yet, macOS simply never delivers key events to it (per
/// Apple's own documented behavior) until the user grants it — there's no
/// failure to catch, it just silently does nothing, so logging the current
/// trust state at start-up is the only honest thing this can do about it.
final class GlobalHotkeyListener {
    /// Called when the hotkey is pressed. `JarvisAgentApp` wires this to
    /// the same `sendVoiceTranscript` entry point `WakeWordListener` uses.
    var onTrigger: (() -> Void)?

    /// The fixed stand-in phrase sent to Core in place of a live
    /// transcription — written as a complete, natural request (not a bare
    /// tool name) so it carries enough context on its own to produce a
    /// real conversational response, the same way a spoken "Hey JARVIS,
    /// look at my screen and tell me what you think" would.
    static let triggerPhrase = "Look at my screen and tell me what you think."

    /// `kVK_ANSI_J`'s raw value (0x26) — Carbon's `HIToolbox` virtual
    /// keycode constants aren't imported here (see the Carbon-vs-AppKit
    /// note above), so the raw code is used directly and named here so a
    /// future change only needs to touch this one line. Confirmed against
    /// Apple's own published `Carbon.HIToolbox.Events` keycode table.
    private static let keyCodeJ: UInt16 = 0x26

    /// Control+Option+J — "J" for JARVIS. Chosen deliberately over a bare
    /// function key or a Cmd-based chord:
    /// - **Control+Option (no Cmd, no Shift)** is a combination almost
    ///   nothing in stock macOS or common apps binds globally — Cmd-based
    ///   chords are where real collisions live (every app defines its own
    ///   Cmd shortcuts), and Control+Option together is rare enough to be
    ///   a safe starting guess without being a function key that varies by
    ///   keyboard (laptop `fn` layer, external keyboards with different
    ///   F-row behavior, media-key remapping) the way F13-style "available"
    ///   keys often do.
    /// - **A letter key mnemonic (J for Jarvis)** is easier for David to
    ///   remember than an arbitrary function key, and easier to describe
    ///   back to him in docs/UI later.
    /// This is a single named pair of constants specifically so it's a
    /// one-line change once David actually tries it on his real keyboard
    /// and reports a collision — same spirit as `WakeWordListener`'s
    /// `preferredEnglishVoiceIdentifier`/`pitchMultiplier` constants being
    /// called out as "easy to swap once heard for real."
    static let modifierFlags: NSEvent.ModifierFlags = [.control, .option]
    static let hotkeyDescription = "Control+Option+J"

    private var monitor: Any?

    func start() {
        guard monitor == nil else { return }

        if AXIsProcessTrusted() {
            print("[JarvisAgent] GlobalHotkeyListener: registering \(Self.hotkeyDescription) (\"look at my screen\") — Accessibility already trusted.")
        } else {
            // Not fatal: `CapabilityReporter.requestAccessibilityIfNeeded()`
            // (called from `main.swift`) prompts for this same permission
            // at launch. The monitor below is still installed so it starts
            // working the moment the user grants access, without needing
            // this Agent restarted.
            print("[JarvisAgent] GlobalHotkeyListener: registering \(Self.hotkeyDescription) (\"look at my screen\") — Accessibility not yet trusted, so key events won't be delivered until it is granted.")
        }

        monitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self else { return }
            guard event.keyCode == Self.keyCodeJ else { return }
            // `.deviceIndependentFlagsMask` strips caps-lock/function-key
            // noise bits so this compares only the modifiers that matter,
            // and requires an EXACT match (not "at least these") so this
            // doesn't also fire for, say, Cmd+Control+Option+J.
            guard event.modifierFlags.intersection(.deviceIndependentFlagsMask) == Self.modifierFlags else { return }

            print("[JarvisAgent] Global hotkey \(Self.hotkeyDescription) pressed — sending to Core: \"\(Self.triggerPhrase)\"")
            self.onTrigger?()
        }
    }

    func stop() {
        if let monitor {
            NSEvent.removeMonitor(monitor)
        }
        monitor = nil
    }
}
