// REQUIRES REAL macOS VALIDATION — file system access cannot be
// exercised outside a real macOS runtime. Never compiled or run in this
// environment.

import Foundation

/// Writes (creates or overwrites) a file under one of
/// `FileAccessPolicy.allowedRoots()` — "save this to my Desktop." The
/// first WRITE capability this Agent has ever had; every other file tool
/// (ReadTextFileTool, ReadFileBytesTool, ListDirectoryTool) is read-only.
/// Core marks this CONFIRM, not SAFE_ACTION: PermissionService still
/// forces a fresh per-invocation human confirmation on every single call
/// regardless of any standing grant (same as ClickElementTool/TypeTextTool),
/// since it can overwrite an existing file with no undo. Same allowlisted-
/// folder restriction and size cap reasoning as ReadFileBytesTool (base64
/// content has to travel through Claude's own context either direction).
enum WriteFileTool {
    private static let maxBytes = 150_000

    static func make() -> AgentTool {
        AgentTool(name: "write_file") { input in
            let path = (input["path"]?.value as? String) ?? ""
            let base64Content = (input["base64Content"]?.value as? String) ?? ""

            guard let resolved = FileAccessPolicy.resolve(path) else {
                return ToolResultPayload(success: false, data: nil, error: "Path is outside the allowed folders")
            }

            guard !base64Content.isEmpty, let data = Data(base64Encoded: base64Content) else {
                return ToolResultPayload(success: false, data: nil, error: "base64Content is missing or not valid base64")
            }
            guard data.count <= maxBytes else {
                return ToolResultPayload(
                    success: false,
                    data: nil,
                    error: "Content is \(data.count) bytes, over the \(maxBytes)-byte limit for write_file"
                )
            }

            let fileManager = FileManager.default
            var isDirectory: ObjCBool = false
            if fileManager.fileExists(atPath: resolved.path, isDirectory: &isDirectory), isDirectory.boolValue {
                return ToolResultPayload(success: false, data: nil, error: "Path is an existing directory: \(path)")
            }
            let overwrote = fileManager.fileExists(atPath: resolved.path)

            do {
                try fileManager.createDirectory(at: resolved.deletingLastPathComponent(), withIntermediateDirectories: true)
                try data.write(to: resolved, options: .atomic)
            } catch {
                return ToolResultPayload(success: false, data: nil, error: "Failed to write file: \(error.localizedDescription)")
            }

            let result: [String: AnyCodable] = [
                "path": AnyCodable(path),
                "bytesWritten": AnyCodable(data.count),
                "overwrote": AnyCodable(overwrote),
            ]
            return ToolResultPayload(success: true, data: AnyCodable(result), error: nil)
        }
    }
}
