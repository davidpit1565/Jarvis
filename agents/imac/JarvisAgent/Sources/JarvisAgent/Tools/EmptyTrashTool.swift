// REQUIRES REAL macOS VALIDATION — file system access cannot be
// exercised outside a real macOS runtime. Never compiled or run in this
// environment.

import Foundation

/// Permanently deletes everything in ~/.Trash by removing each entry
/// directly via FileManager — not AppleScript's "empty trash" Finder
/// command, not a shell `rm -rf`. Scoped to exactly one well-known
/// directory (never anywhere FileAccessPolicy's allowlist covers, since
/// this isn't a read/write-inside-allowed-folders operation — it only
/// ever touches ~/.Trash itself). Irreversible once run, which is why
/// this tool is CONFIRM-gated on the Core side (see ToolRegistry.ts) —
/// though everything in the Trash is, by definition, something the user
/// already chose to discard.
enum EmptyTrashTool {
    static func make() -> AgentTool {
        AgentTool(name: "empty_trash") { _ in
            let fileManager = FileManager.default
            let trashURL = fileManager.homeDirectoryForCurrentUser.appendingPathComponent(".Trash")

            guard let entries = try? fileManager.contentsOfDirectory(
                at: trashURL,
                includingPropertiesForKeys: nil,
                options: [.skipsHiddenFiles]
            ) else {
                return ToolResultPayload(success: false, data: nil, error: "Could not read the Trash folder")
            }

            var deletedCount = 0
            var failures: [String] = []
            for entry in entries {
                do {
                    try fileManager.removeItem(at: entry)
                    deletedCount += 1
                } catch {
                    failures.append(entry.lastPathComponent)
                }
            }

            if !failures.isEmpty {
                return ToolResultPayload(
                    success: false, data: AnyCodable(["deletedCount": AnyCodable(deletedCount)]),
                    error: "Deleted \(deletedCount) item(s), but failed on: \(failures.joined(separator: ", "))"
                )
            }

            let result: [String: AnyCodable] = ["deletedCount": AnyCodable(deletedCount)]
            return ToolResultPayload(success: true, data: AnyCodable(result), error: nil)
        }
    }
}
