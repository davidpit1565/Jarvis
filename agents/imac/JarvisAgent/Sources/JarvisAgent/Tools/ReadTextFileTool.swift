// REQUIRES REAL macOS VALIDATION — file system access cannot be
// exercised outside a real macOS runtime. Never compiled or run in this
// environment.

import Foundation

/// Reads a text file's contents from under one of
/// `FileAccessPolicy.allowedRoots()` — e.g. "read that PDF's notes file
/// on my Desktop." Read-only, and deliberately text-only: this is not a
/// generic binary file reader, so photos/videos/binaries are rejected
/// rather than base64-dumped into the conversation. Capped at
/// `maxBytes` so one huge file can't blow up context/cost the same way
/// GmailClient's message bodies are now capped.
enum ReadTextFileTool {
    private static let maxBytes = 200_000

    static func make() -> AgentTool {
        AgentTool(name: "read_text_file") { input in
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

            guard let data = fileManager.contents(atPath: resolved.path) else {
                return ToolResultPayload(success: false, data: nil, error: "Failed to read file")
            }

            guard let text = String(data: data.prefix(maxBytes), encoding: .utf8) else {
                return ToolResultPayload(success: false, data: nil, error: "File is not readable as text")
            }

            let truncated = sizeBytes > maxBytes
            let content = truncated ? "\(text)\n\n[... truncated, \(sizeBytes - maxBytes) more bytes]" : text

            let result: [String: AnyCodable] = [
                "path": AnyCodable(path),
                "content": AnyCodable(content),
                "truncated": AnyCodable(truncated),
            ]
            return ToolResultPayload(success: true, data: AnyCodable(result), error: nil)
        }
    }
}
