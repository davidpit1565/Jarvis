// REQUIRES REAL macOS VALIDATION — NSWorkspace cannot be exercised outside
// a real macOS runtime. Never compiled or run in this environment.

import AppKit

/// Lists the names of currently running, regular (user-visible) apps via
/// the public `NSWorkspace.shared.runningApplications` API — same
/// low-privilege spirit as GetActiveApplicationTool: no window titles or
/// contents, just which apps are open. `activationPolicy == .regular`
/// filters out background-only processes/menu-bar helpers, which would
/// otherwise flood the result with names the user has never heard of.
enum ListRunningApplicationsTool {
    static func make() -> AgentTool {
        AgentTool(name: "list_running_applications") { _ in
            let names = NSWorkspace.shared.runningApplications
                .filter { $0.activationPolicy == .regular }
                .compactMap { $0.localizedName }
                .sorted()

            let result: [String: AnyCodable] = ["applications": AnyCodable(names)]
            return ToolResultPayload(success: true, data: AnyCodable(result), error: nil)
        }
    }
}
