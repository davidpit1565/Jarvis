// REQUIRES REAL macOS VALIDATION — NSWorkspace cannot be exercised outside
// a real macOS runtime. Never compiled or run in this environment.

import AppKit

/// Opens a URL in the default browser. Only http/https is accepted here
/// too, not just in Core's OpenUrlTool.validateInput — this Agent is
/// Phase 2's actual security boundary (see AgentToolRegistry's own docs),
/// so it must never assume Core already checked. Every other scheme
/// (`file://`, `javascript:`, a third-party app's custom URL scheme) is
/// rejected before NSWorkspace ever sees it.
enum OpenUrlTool {
    static func make() -> AgentTool {
        AgentTool(name: "open_url") { input in
            guard let raw = input["url"]?.value as? String else {
                return ToolResultPayload(success: false, data: nil, error: "Missing required \"url\" string")
            }
            guard let url = URL(string: raw), let scheme = url.scheme?.lowercased() else {
                return ToolResultPayload(success: false, data: nil, error: "Not a valid absolute URL")
            }
            guard scheme == "http" || scheme == "https" else {
                return ToolResultPayload(success: false, data: nil, error: "Scheme \"\(scheme)\" is not allowed")
            }

            let opened = NSWorkspace.shared.open(url)
            guard opened else {
                return ToolResultPayload(success: false, data: nil, error: "The system declined to open this URL")
            }
            return ToolResultPayload(success: true, data: AnyCodable(["url": AnyCodable(raw)]), error: nil)
        }
    }
}
