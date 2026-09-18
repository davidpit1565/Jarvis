// REQUIRES REAL macOS VALIDATION — file system access cannot be
// exercised outside a real macOS runtime. Never compiled or run in this
// environment.

import Foundation

/// Creates a new folder under one of `FileAccessPolicy.allowedRoots()`
/// (Desktop, Documents, Downloads, or the dedicated Jarvis folder) — the
/// write counterpart to ListDirectoryTool's read-only listing. Refuses to
/// create anything outside that same allowlist, and refuses to overwrite
/// an existing file/folder silently (fails instead).
enum CreateFolderTool {
    static func make() -> AgentTool {
        AgentTool(name: "create_folder") { input in
            guard let path = input["path"]?.value as? String, !path.trimmingCharacters(in: .whitespaces).isEmpty else {
                return ToolResultPayload(success: false, data: nil, error: "path is required")
            }

            guard let resolved = FileAccessPolicy.resolve(path) else {
                return ToolResultPayload(success: false, data: nil, error: "Path is outside the allowed folders")
            }

            let fileManager = FileManager.default
            if fileManager.fileExists(atPath: resolved.path) {
                return ToolResultPayload(success: false, data: nil, error: "Something already exists at that path: \(path)")
            }

            do {
                try fileManager.createDirectory(at: resolved, withIntermediateDirectories: true)
                let result: [String: AnyCodable] = ["path": AnyCodable(path)]
                return ToolResultPayload(success: true, data: AnyCodable(result), error: nil)
            } catch {
                return ToolResultPayload(success: false, data: nil, error: "Failed to create folder: \(error.localizedDescription)")
            }
        }
    }
}
