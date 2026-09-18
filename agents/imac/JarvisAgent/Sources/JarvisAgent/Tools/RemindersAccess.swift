// REQUIRES REAL macOS VALIDATION — EventKit's Reminders store cannot be
// exercised outside a real macOS runtime. Never compiled or run in this
// environment.

import EventKit

/// Shared helper for the three macOS-native-Reminders tools below. Bridges
/// EventKit's async authorization request into the synchronous
/// `AgentTool.execute` closure shape with a semaphore — the same kind of
/// bridge the rest of this Agent avoids needing only because its other
/// frameworks (CoreAudio, CoreWLAN, FileManager) are already synchronous.
/// Never asks for anything beyond `EKEntityType.reminder` access — no
/// Calendar access, which is a separate, broader grant EventKit would
/// otherwise bundle in.
enum RemindersAccess {
    static let store = EKEventStore()

    static func requestAccess() -> Bool {
        let semaphore = DispatchSemaphore(value: 0)
        var granted = false
        store.requestAccess(to: .reminder) { didGrant, _ in
            granted = didGrant
            semaphore.signal()
        }
        semaphore.wait()
        return granted
    }

    static func withAccess(_ body: () -> ToolResultPayload) -> ToolResultPayload {
        guard requestAccess() else {
            return ToolResultPayload(success: false, data: nil, error: "Reminders access was not granted")
        }
        return body()
    }
}
