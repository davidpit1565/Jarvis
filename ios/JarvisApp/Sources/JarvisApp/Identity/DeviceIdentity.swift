// NEVER COMPILED OR RUN — no Xcode/iOS toolchain in this sandbox.

import Foundation

/// Generates and persists this iPhone's stable JARVIS device ID — same
/// shape and same reasoning as the Mac agent's `DeviceIdentity.swift`: a
/// random UUID, not derived from any hardware identifier, not a secret.
/// `.applicationSupportDirectory` resolves inside this app's own sandboxed
/// container on iOS exactly as it does in Application Support on macOS —
/// no change needed from the Mac agent's approach, just a different real
/// directory on disk.
enum DeviceIdentity {
    private static var identityFileURL: URL {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = appSupport.appendingPathComponent("JarvisApp", isDirectory: true)
        return dir.appendingPathComponent("device-id.txt")
    }

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
