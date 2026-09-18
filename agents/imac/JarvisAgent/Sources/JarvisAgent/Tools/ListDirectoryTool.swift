// REQUIRES REAL macOS VALIDATION — file system access cannot be
// exercised outside a real macOS runtime. Never compiled or run in this
// environment.

import Foundation

/// Lists the names and basic metadata of entries in a directory under
/// one of `FileAccessPolicy.allowedRoots()` (Desktop, Documents,
/// Downloads, or the dedicated Jarvis folder) — e.g. "what's on my
/// Desktop", "what's in my Downloads folder". Read-only: never creates,
/// deletes, or modifies anything, and never lists outside the allowlist.
enum ListDirectoryTool {
    static func make() -> AgentTool {
        AgentTool(name: "list_directory") { input in
            let path = (input["path"]?.value as? String) ?? ""

            guard let resolved = FileAccessPolicy.resolve(path) else {
                return ToolResultPayload(success: false, data: nil, error: "Path is outside the allowed folders")
            }

            let fileManager = FileManager.default
            var isDirectory: ObjCBool = false
            guard fileManager.fileExists(atPath: resolved.path, isDirectory: &isDirectory), isDirectory.boolValue else {
                return ToolResultPayload(success: false, data: nil, error: "Not a directory: \(path)")
            }

            do {
                let entries = try fileManager.contentsOfDirectory(
                    at: resolved,
                    includingPropertiesForKeys: [.isDirectoryKey, .fileSizeKey],
                    options: [.skipsHiddenFiles]
                )

                let listing = entries.map { entry -> [String: AnyCodable] in
                    let values = try? entry.resourceValues(forKeys: [.isDirectoryKey, .fileSizeKey])
                    return [
                        "name": AnyCodable(entry.lastPathComponent),
                        "type": AnyCodable((values?.isDirectory ?? false) ? "directory" : "file"),
                        "sizeBytes": AnyCodable(values?.fileSize ?? 0),
                    ]
                }

                let result: [String: AnyCodable] = ["entries": AnyCodable(listing)]
                return ToolResultPayload(success: true, data: AnyCodable(result), error: nil)
            } catch {
                return ToolResultPayload(success: false, data: nil, error: "Failed to list directory: \(error.localizedDescription)")
            }
        }
    }
}
