// REQUIRES REAL macOS VALIDATION — NSWorkspace cannot be exercised outside
// a real macOS runtime. Never compiled or run in this environment.

import AppKit

/// Opens a pre-filled email draft via a `mailto:` URL handed to
/// NSWorkspace — the default mail client composes the message and shows
/// it to the user. This NEVER sends anything: `mailto:` only ever opens a
/// compose window, there is no OS-level API this could call that would
/// send on the user's behalf, which is exactly why this tool is scoped to
/// drafts only (see ComposeEmailDraftTool.ts on the Core side).
enum ComposeEmailDraftTool {
    static func make() -> AgentTool {
        AgentTool(name: "compose_email_draft") { input in
            guard let to = input["to"]?.value as? String, !to.isEmpty else {
                return ToolResultPayload(success: false, data: nil, error: "Missing required \"to\" string")
            }

            var components = URLComponents()
            components.scheme = "mailto"
            components.path = to
            var queryItems: [URLQueryItem] = []
            if let subject = input["subject"]?.value as? String, !subject.isEmpty {
                queryItems.append(URLQueryItem(name: "subject", value: subject))
            }
            if let body = input["body"]?.value as? String, !body.isEmpty {
                queryItems.append(URLQueryItem(name: "body", value: body))
            }
            if !queryItems.isEmpty { components.queryItems = queryItems }

            guard let url = components.url else {
                return ToolResultPayload(success: false, data: nil, error: "Could not build a mailto: URL for this input")
            }

            let opened = NSWorkspace.shared.open(url)
            guard opened else {
                return ToolResultPayload(success: false, data: nil, error: "The system declined to open a mail compose window")
            }
            return ToolResultPayload(success: true, data: AnyCodable(["to": AnyCodable(to)]), error: nil)
        }
    }
}
