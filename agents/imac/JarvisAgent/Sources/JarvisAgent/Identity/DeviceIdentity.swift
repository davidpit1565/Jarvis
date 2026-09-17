// REQUIRES REAL macOS VALIDATION — never compiled or run in this environment.

import Foundation

/// Generates and persists this Mac's stable JARVIS device ID.
///
/// The ID itself (a random UUID, not derived from hardware serial or any
/// other identifying system property) is not a secret and is not
/// authentication — it is just a stable name. It is safe to keep in a
/// plain file. The actual credential that authenticates this device to
/// Core lives only in the Keychain (see KeychainStore).
enum DeviceIdentity {
    private static var identityFileURL: URL {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = appSupport.appendingPathComponent("JarvisAgent", isDirectory: true)
        return dir.appendingPathComponent("device-id.txt")
    }

    /// Returns this Mac's persisted device ID, generating and storing one
    /// on first run.
    static func loadOrCreate() -> String {
        let url = identityFileURL

        if let existing = try? String(contentsOf: url, encoding: .utf8) {
            let trimmed = existing.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                return trimmed
            }
        }

        let newId = UUID().uuidString
        try? FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try? newId.write(to: url, atomically: true, encoding: .utf8)
        return newId
    }
}
