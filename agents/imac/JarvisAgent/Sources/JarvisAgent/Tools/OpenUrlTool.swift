// REQUIRES REAL macOS VALIDATION — NSWorkspace cannot be exercised outside
// a real macOS runtime. Never compiled or run in this environment.

import AppKit

/// Opens a URL in the user's default browser via the OS's own public
/// open-URL API — the same low-privilege spirit as OpenApplicationTool.
/// Only `http`/`https` URLs are accepted: this is deliberately not a
/// generic "open any URL scheme" tool, since some custom schemes on macOS
/// are handled by installed apps in ways that can trigger unexpected
/// actions (e.g. a "compose email and send" or a payment-app deep link).
enum OpenUrlTool {
    static func make() -> AgentTool {
        AgentTool(name: "open_url") { input in
            guard let urlString = input["url"]?.value as? String,
                  !urlString.trimmingCharacters(in: .whitespaces).isEmpty
            else {
                return ToolResultPayload(success: false, data: nil, error: "url is required")
            }

            guard let url = URL(string: urlString),
                  let scheme = url.scheme?.lowercased(),
                  scheme == "http" || scheme == "https"
            else {
                return ToolResultPayload(success: false, data: nil, error: "url must be a valid http/https URL")
            }

            guard NSWorkspace.shared.open(url) else {
                return ToolResultPayload(success: false, data: nil, error: "Failed to open URL: \(urlString)")
            }

            let result: [String: AnyCodable] = ["url": AnyCodable(urlString)]
            return ToolResultPayload(success: true, data: AnyCodable(result), error: nil)
        }
    }
}
