// REQUIRES REAL macOS VALIDATION — NSRunningApplication cannot be
// exercised outside a real macOS runtime. Never compiled or run in this
// environment.

import AppKit

/// Quits a named, already-running application by asking it to terminate
/// via the OS's own public API — the reverse of OpenApplicationTool.
/// Deliberately NOT "kill any process by PID/name": only an application
/// NSWorkspace itself already knows is running gets asked to quit, the
/// same low-privilege spirit as the rest of this registry (see
/// ToolRegistry.swift) — there is no code path here that can terminate
/// anything other than a regular, user-visible app.
enum QuitApplicationTool {
    static func make() -> AgentTool {
        AgentTool(name: "quit_application") { input in
            guard let applicationName = input["applicationName"]?.value as? String,
                  !applicationName.trimmingCharacters(in: .whitespaces).isEmpty
            else {
                return ToolResultPayload(success: false, data: nil, error: "applicationName is required")
            }

            let runningApps = NSWorkspace.shared.runningApplications.filter { app in
                app.localizedName?.caseInsensitiveCompare(applicationName) == .orderedSame
            }

            guard !runningApps.isEmpty else {
                return ToolResultPayload(success: false, data: nil, error: "Application not running: \(applicationName)")
            }

            for app in runningApps {
                app.terminate()
            }

            let result: [String: AnyCodable] = ["application": AnyCodable(applicationName)]
            return ToolResultPayload(success: true, data: AnyCodable(result), error: nil)
        }
    }
}
