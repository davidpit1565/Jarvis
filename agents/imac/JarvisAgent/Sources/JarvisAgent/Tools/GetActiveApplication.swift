// REQUIRES REAL macOS VALIDATION — NSWorkspace cannot be exercised outside
// a real macOS runtime. Never compiled or run in this environment.

import AppKit

/// The only tool implemented in Phase 2. Read-only: reports the frontmost
/// application's name and bundle identifier via the public
/// `NSWorkspace.shared.frontmostApplication` API. Deliberately does NOT
/// read window titles/contents (which would need the Accessibility or
/// Screen Recording permission) — this stays a low-privilege, low-risk
/// first tool by design, matching Core's GET_ACTIVE_APPLICATION tool
/// definition (src/tools/system/GetActiveApplicationTool.ts).
enum GetActiveApplicationTool {
    static func make() -> AgentTool {
        AgentTool(name: "get_active_application") { _ in
            guard let app = NSWorkspace.shared.frontmostApplication else {
                return ToolResultPayload(success: false, data: nil, error: "No frontmost application")
            }

            let result: [String: AnyCodable] = [
                "application": AnyCodable(app.localizedName ?? "Unknown"),
                "bundleId": AnyCodable(app.bundleIdentifier ?? "unknown"),
            ]

            return ToolResultPayload(success: true, data: AnyCodable(result), error: nil)
        }
    }
}
