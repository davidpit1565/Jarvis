// REQUIRES REAL macOS VALIDATION — file system resolution against real
// user directories cannot be exercised outside a real macOS runtime.
// Never compiled or run in this environment.

import Foundation

/// The single gate every file-reading tool on this Agent goes through
/// before touching disk. Deliberately conservative, mirroring Core's own
/// `pathValidation.ts`: JARVIS gets a few specific, user-relevant folders
/// (Desktop, Documents, Downloads, and a dedicated "Jarvis" folder David
/// can drop things into on purpose) — never the whole home directory,
/// and never "/". This is what "JARVIS has access to my files" safely
/// means in this codebase: a short, explicit allowlist, not raw
/// filesystem access.
enum FileAccessPolicy {
    /// Roots JARVIS is allowed to list/read from. Resolved lazily (not at
    /// process start) so a symlink swap after launch can't be used to
    /// redirect an already-resolved root.
    static func allowedRoots() -> [URL] {
        let home = FileManager.default.homeDirectoryForCurrentUser
        return [
            home.appendingPathComponent("Desktop"),
            home.appendingPathComponent("Documents"),
            home.appendingPathComponent("Downloads"),
            home.appendingPathComponent("Jarvis"),
        ]
    }

    /// Resolves `path` (which may be relative to the home directory, or
    /// absolute) and confirms the *real*, symlink-resolved location falls
    /// within one of `allowedRoots()`. Returns nil (rejected) otherwise.
    static func resolve(_ path: String) -> URL? {
        if path.isEmpty || path.contains("\0") {
            return nil
        }

        let home = FileManager.default.homeDirectoryForCurrentUser
        let candidate = path.hasPrefix("/") ? URL(fileURLWithPath: path) : home.appendingPathComponent(path)
        let resolved = candidate.resolvingSymlinksInPath().standardizedFileURL

        let isWithinAnAllowedRoot = allowedRoots().contains { root in
            let resolvedRoot = root.resolvingSymlinksInPath().standardizedFileURL
            return resolved == resolvedRoot || resolved.path.hasPrefix(resolvedRoot.path + "/")
        }

        return isWithinAnAllowedRoot ? resolved : nil
    }
}
