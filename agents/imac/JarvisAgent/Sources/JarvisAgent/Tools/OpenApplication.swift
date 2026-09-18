// REQUIRES REAL macOS VALIDATION — NSWorkspace/FileManager app lookup
// cannot be exercised outside a real macOS runtime. Never compiled or run
// in this environment.

import AppKit

/// Launches a named application, matched by exact display name against
/// the standard install locations (`/Applications`, `/System/Applications`,
/// `~/Applications`) — deliberately a name match on well-known folders,
/// not a Spotlight-wide search, so this can't be tricked into resolving
/// to something unexpected outside where applications actually live.
/// A name that isn't found in any of these is reported as not found
/// rather than falling back to a broader (riskier) search.
enum OpenApplicationTool {
    private static let searchDirectories = [
        "/Applications",
        "/System/Applications",
        NSHomeDirectory() + "/Applications",
    ]

    static func make() -> AgentTool {
        AgentTool(name: "open_application") { input in
            guard let name = input["applicationName"]?.value as? String, !name.isEmpty else {
                return ToolResultPayload(success: false, data: nil, error: "Missing required \"applicationName\" string")
            }

            for directory in searchDirectories {
                let candidate = URL(fileURLWithPath: directory).appendingPathComponent("\(name).app")
                if FileManager.default.fileExists(atPath: candidate.path) {
                    let opened = NSWorkspace.shared.open(candidate)
                    guard opened else {
                        return ToolResultPayload(success: false, data: nil, error: "The system declined to launch \"\(name)\"")
                    }
                    return ToolResultPayload(success: true, data: AnyCodable(["applicationName": AnyCodable(name)]), error: nil)
                }
            }

            return ToolResultPayload(success: false, data: nil, error: "No application named \"\(name)\" found")
        }
    }
}
