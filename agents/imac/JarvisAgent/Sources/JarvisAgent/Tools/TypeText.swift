// REQUIRES REAL macOS VALIDATION — CGEvent keyboard simulation cannot be
// exercised outside a real macOS runtime with the Accessibility
// permission actually granted to this process. Never compiled or run in
// this environment.

import AppKit
import CoreGraphics

/// Types text into whatever currently has keyboard focus, as real
/// simulated keystrokes — via CGEvent's Unicode-string keyboard event,
/// which types arbitrary text directly without needing a per-character
/// virtual-keycode/layout mapping (the standard technique for this on
/// macOS). Does not select or focus anything itself — see
/// ClickElementTool for that half of "click here, then type this."
enum TypeTextTool {
    /// CGEventKeyboardSetUnicodeString takes a UniChar (UTF-16) buffer;
    /// posting in chunks avoids the rare (long-paragraph) case of
    /// exceeding a single event's practical buffer size.
    private static let chunkSize = 20

    static func make() -> AgentTool {
        AgentTool(name: "type_text") { input in
            guard let text = input["text"]?.value as? String, !text.isEmpty else {
                return ToolResultPayload(success: false, data: nil, error: "Missing required \"text\" string")
            }
            guard let source = CGEventSource(stateID: .hidSystemState) else {
                return ToolResultPayload(success: false, data: nil, error: "Could not create a CGEventSource")
            }

            let units = Array(text.utf16)
            for chunkStart in stride(from: 0, to: units.count, by: chunkSize) {
                let chunk = Array(units[chunkStart..<min(chunkStart + chunkSize, units.count)])
                guard let keyDown = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
                      let keyUp = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else {
                    return ToolResultPayload(success: false, data: nil, error: "Could not create a keyboard event")
                }
                keyDown.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
                keyUp.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
                keyDown.post(tap: .cghidEventTap)
                keyUp.post(tap: .cghidEventTap)
            }

            return ToolResultPayload(success: true, data: AnyCodable(["length": AnyCodable(Double(text.count))]), error: nil)
        }
    }
}
