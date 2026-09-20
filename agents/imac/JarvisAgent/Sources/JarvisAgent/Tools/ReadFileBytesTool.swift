// REQUIRES REAL macOS VALIDATION — file system access cannot be
// exercised outside a real macOS runtime. Never compiled or run in this
// environment.

import Foundation

/// Reads ANY file (not just text — see ReadTextFileTool for that) from
/// under one of `FileAccessPolicy.allowedRoots()` and returns it
/// base64-encoded — the building block SHARE_FILE_TO_PHONE (Core-side)
/// uses to actually get a file's bytes off the Mac at all. Capped hard
/// at `maxBytes`, much smaller than ReadTextFileTool's own cap: the
/// caller (Claude) has to carry this base64 content through its own
/// context to hand it to the next tool call, so this is sized for "a
/// small document or thumbnail," not "a real photo or video" — see
/// ShareFileToPhoneTool.ts's doc comment for the honest limitation this
/// implies.
enum ReadFileBytesTool {
    private static let maxBytes = 150_000

    static func make() -> AgentTool {
        AgentTool(name: "read_file_bytes") { input in
            let path = (input["path"]?.value as? String) ?? ""

            guard let resolved = FileAccessPolicy.resolve(path) else {
                return ToolResultPayload(success: false, data: nil, error: "Path is outside the allowed folders")
            }

            let fileManager = FileManager.default
            var isDirectory: ObjCBool = false
            guard fileManager.fileExists(atPath: resolved.path, isDirectory: &isDirectory), !isDirectory.boolValue else {
                return ToolResultPayload(success: false, data: nil, error: "Not a file: \(path)")
            }

            guard let attributes = try? fileManager.attributesOfItem(atPath: resolved.path),
                  let sizeBytes = attributes[.size] as? Int
            else {
                return ToolResultPayload(success: false, data: nil, error: "Failed to read file metadata")
            }

            guard sizeBytes <= maxBytes else {
                return ToolResultPayload(
                    success: false,
                    data: nil,
                    error: "File is \(sizeBytes) bytes, over the \(maxBytes)-byte limit for read_file_bytes"
                )
            }

            guard let data = fileManager.contents(atPath: resolved.path) else {
                return ToolResultPayload(success: false, data: nil, error: "Failed to read file")
            }

            let result: [String: AnyCodable] = [
                "path": AnyCodable(path),
                "filename": AnyCodable(resolved.lastPathComponent),
                "base64Content": AnyCodable(data.base64EncodedString()),
                "sizeBytes": AnyCodable(sizeBytes),
            ]
            return ToolResultPayload(success: true, data: AnyCodable(result), error: nil)
        }
    }
}
