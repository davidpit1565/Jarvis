// REQUIRES REAL macOS VALIDATION — NSWorkspace cannot be exercised outside
// a real macOS runtime. Never compiled or run in this environment.

import AppKit

/// Launches a named application by its display name — e.g. "open
/// WhatsApp." Deliberately NOT a generic "run this command"/AppleScript
/// tool: the only thing this can ever do is ask the OS's own public
/// app-launch API (`NSWorkspace`) to open a known application, the same
/// low-privilege spirit as GetActiveApplicationTool. There is no code
/// path here that runs a shell command, a script, or anything other than
/// launching an app by name — matching this file's whole registry's
/// design (see ToolRegistry.swift): every capability is a named,
/// compiled-in function, never an arbitrary command.
enum OpenApplicationTool {
    static func make() -> AgentTool {
        AgentTool(name: "open_application") { input in
            guard let applicationName = input["applicationName"]?.value as? String,
                  !applicationName.trimmingCharacters(in: .whitespaces).isEmpty
            else {
                return ToolResultPayload(success: false, data: nil, error: "applicationName is required")
            }

            guard let appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: applicationName)
                ?? findApplicationURL(named: applicationName)
            else {
                return ToolResultPayload(success: false, data: nil, error: "Application not found: \(applicationName)")
            }

            let configuration = NSWorkspace.OpenConfiguration()
            var launchError: Error?
            let semaphore = DispatchSemaphore(value: 0)

            NSWorkspace.shared.openApplication(at: appURL, configuration: configuration) { _, error in
                launchError = error
                semaphore.signal()
            }
            semaphore.wait()

            if let launchError {
                return ToolResultPayload(success: false, data: nil, error: launchError.localizedDescription)
            }

            let result: [String: AnyCodable] = ["application": AnyCodable(applicationName)]
            return ToolResultPayload(success: true, data: AnyCodable(result), error: nil)
        }
    }

    /// Resolves a plain display name (e.g. "WhatsApp") to an application
    /// URL by searching standard install locations — `urlForApplication`
    /// alone only works reliably with a bundle identifier, and Claude will
    /// usually be given/pass the human-readable name.
    private static func findApplicationURL(named name: String) -> URL? {
        let fileManager = FileManager.default
        let searchDirectories = [
            "/Applications",
            "/System/Applications",
            "\(NSHomeDirectory())/Applications",
        ]

        for directory in searchDirectories {
            let candidate = "\(directory)/\(name).app"
            if fileManager.fileExists(atPath: candidate) {
                return URL(fileURLWithPath: candidate)
            }
        }
        return nil
    }
}
