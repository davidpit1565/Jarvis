// REQUIRES REAL macOS VALIDATION — never compiled or run in this environment.
// Every permission-status API called here (AXIsProcessTrusted,
// AVCaptureDevice.authorizationStatus, SFSpeechRecognizer.authorizationStatus,
// EKEventStore.authorizationStatus, UNUserNotificationCenter.getNotificationSettings)
// is a real, documented Apple API used by exact name/signature; nothing here
// has been exercised against a real TCC database or a real permission
// prompt, so treat every reported status as unverified until a real Mac
// confirms it actually reflects what System Settings shows.

import AppKit
import AVFoundation
import EventKit
import Foundation
import Speech
import UserNotifications

/// Answers "which capabilities does this Agent actually have available
/// right now" — the Swift-side half of capability discovery (roadmap
/// #79/#80). Distinct from `AgentToolRegistry`, which only says which
/// *tools* are compiled in; this says whether each tool's underlying OS
/// permission has actually been granted, so Core (and eventually the
/// user, via a UI) can know "CLICK_ELEMENT is registered but Accessibility
/// isn't granted, so it will fail" *before* dispatching a call that's
/// certain to fail, rather than only learning that from a failed
/// tool.result.
///
/// Every status is read fresh on each call — nothing here is cached —
/// since the whole point is catching a permission that changed (granted
/// or revoked) since the Agent last reported it.
enum CapabilityReporter {
    /// Capability keys this Agent reports. Kept as string constants (not
    /// an enum shared with Core) since the wire protocol treats capability
    /// names as opaque strings by design (see `protocol.ts`'s
    /// `DeviceCapabilitiesPayload` doc comment) — a newer Agent build can
    /// report a capability name an older Core doesn't recognize yet
    /// without either side needing a coordinated release.
    enum Key {
        static let accessibility = "accessibility"
        static let microphone = "microphone"
        static let speechRecognition = "speech_recognition"
        static let reminders = "reminders"
        static let notifications = "notifications"
    }

    /// Gathers every permission this Agent's tools depend on. Notification
    /// status is the only one that's inherently asynchronous
    /// (`UNUserNotificationCenter.getNotificationSettings`), so the whole
    /// call is completion-based rather than mixing sync reads with one
    /// async one. `completion` is always called back on the main queue,
    /// matching how the rest of `main.swift` touches `connection`/`statusBar`.
    static func currentPermissions(completion: @escaping ([String: String]) -> Void) {
        var permissions: [String: String] = [:]

        // Accessibility (CLICK_ELEMENT, TYPE_TEXT): AXIsProcessTrusted() is
        // a plain boolean API — there is no "not determined"/"restricted"
        // state for Accessibility the way there is for TCC-mediated
        // capabilities below, so it's reported as granted/denied only.
        permissions[Key.accessibility] = AXIsProcessTrusted() ? "granted" : "denied"

        // Microphone (wake-word listening).
        permissions[Key.microphone] = mapAVAuthorization(AVCaptureDevice.authorizationStatus(for: .audio))

        // Speech recognition (wake-word transcription) — a distinct TCC
        // permission from microphone access; a Mac can grant one without
        // the other.
        permissions[Key.speechRecognition] = mapSpeechAuthorization(SFSpeechRecognizer.authorizationStatus())

        // Reminders (List/Create/CompleteMacReminderTool, via EventKit).
        permissions[Key.reminders] = mapEventKitAuthorization(EKEventStore.authorizationStatus(for: .reminder))

        // Notifications (show_notification) — the only genuinely async
        // check of the group.
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            permissions[Key.notifications] = mapNotificationAuthorization(settings.authorizationStatus)
            DispatchQueue.main.async {
                completion(permissions)
            }
        }
    }

    /// Asks macOS for Accessibility access when it isn't already granted.
    ///
    /// `AXIsProcessTrusted()` — what `currentPermissions` reads — is a pure
    /// query: it never prompts, and, crucially, it never registers this app
    /// in System Settings › Privacy & Security › Accessibility. An app that
    /// only ever calls it therefore stays invisible in that list until the
    /// user adds it by hand with the "+" button, and a user who does that
    /// has no way of telling this app apart from a stale binary of the same
    /// name they granted months ago — they can toggle the wrong row on and
    /// nothing changes, with no feedback anywhere.
    ///
    /// `AXIsProcessTrustedWithOptions` with the prompt option is the
    /// documented way to ask: macOS puts this app in the list under the
    /// identity it actually launched with and shows the user a dialog that
    /// opens the right pane. Called once per launch and only while access
    /// is missing, so a Mac that has already granted it never sees a
    /// dialog. The return value is the same boolean `AXIsProcessTrusted()`
    /// gives and is deliberately discarded: granting happens in System
    /// Settings, out of process, long after this call returns, so the
    /// answer here is "no" even in the run where the user says yes. The
    /// next `currentPermissions` (on the next launch, or the next
    /// reconnect) is what reports the real state.
    static func requestAccessibilityIfNeeded() {
        guard !AXIsProcessTrusted() else { return }

        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
    }

    private static func mapAVAuthorization(_ status: AVAuthorizationStatus) -> String {
        switch status {
        case .authorized: return "granted"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "not_determined"
        @unknown default: return "unsupported"
        }
    }

    private static func mapSpeechAuthorization(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
        switch status {
        case .authorized: return "granted"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "not_determined"
        @unknown default: return "unsupported"
        }
    }

    private static func mapEventKitAuthorization(_ status: EKAuthorizationStatus) -> String {
        switch status {
        case .authorized: return "granted"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "not_determined"
        @unknown default:
            // Covers .fullAccess/.writeOnly, introduced in later SDKs than
            // this package's deployment target may target — both mean
            // "some form of access granted," so a caller that only checks
            // for "granted" for a UI hint isn't badly misled by
            // "unsupported" here, but this is exactly the kind of
            // SDK-version detail that needs a real build to confirm.
            return "unsupported"
        }
    }

    private static func mapNotificationAuthorization(_ status: UNAuthorizationStatus) -> String {
        switch status {
        case .authorized, .provisional, .ephemeral: return "granted"
        case .denied: return "denied"
        case .notDetermined: return "not_determined"
        @unknown default: return "unsupported"
        }
    }
}
