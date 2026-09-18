// REQUIRES REAL macOS VALIDATION — CoreWLAN interface control cannot be
// exercised outside a real macOS runtime. Never compiled or run in this
// environment.

import CoreWLAN
import Foundation

/// Turns the Mac's Wi-Fi radio on or off via CoreWLAN's own public API
/// (`CWInterface.setPower(_:)`) — the same framework System Settings'
/// own Wi-Fi toggle uses. Not a shell command, not AppleScript.
enum ToggleWifiTool {
    static func make() -> AgentTool {
        AgentTool(name: "toggle_wifi") { input in
            guard let enabled = input["enabled"]?.value as? Bool else {
                return ToolResultPayload(success: false, data: nil, error: "enabled (true/false) is required")
            }

            guard let interface = CWWiFiClient.shared().interface() else {
                return ToolResultPayload(success: false, data: nil, error: "No Wi-Fi interface found on this Mac")
            }

            do {
                try interface.setPower(enabled)
                let result: [String: AnyCodable] = ["enabled": AnyCodable(enabled)]
                return ToolResultPayload(success: true, data: AnyCodable(result), error: nil)
            } catch {
                return ToolResultPayload(success: false, data: nil, error: "Failed to set Wi-Fi power: \(error.localizedDescription)")
            }
        }
    }
}
