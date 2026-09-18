// REQUIRES REAL macOS VALIDATION — the Accessibility API cannot be
// exercised outside a real macOS runtime with the Accessibility
// permission actually granted to this process. Never compiled or run in
// this environment.

import AppKit
import ApplicationServices

/// Clicks a UI element in the frontmost application, found by matching
/// its accessible label against a description — never by raw screen
/// coordinates (see ClickElementTool.ts on the Core side for why: a
/// coordinate can silently click the wrong thing after any window
/// move/resize/display-scaling change; a label match either finds the
/// right element or fails loudly).
///
/// Requires the Accessibility permission (System Settings > Privacy &
/// Security > Accessibility) to be granted to this Agent — unlike
/// GetActiveApplicationTool, which was deliberately scoped to avoid
/// needing it. This is the first tool in this Agent that does.
///
/// Deliberately conservative about matching: searches only the
/// frontmost application's own accessibility tree (never system-wide),
/// and requires the description to match exactly one clickable element's
/// title/description/value (case-insensitive substring) — zero matches
/// or more than one both fail with a clear reason rather than guessing.
enum ClickElementTool {
    private static let maxDepth = 12
    private static let maxElementsVisited = 4000

    static func make() -> AgentTool {
        AgentTool(name: "click_element") { input in
            guard let description = input["description"]?.value as? String, !description.isEmpty else {
                return ToolResultPayload(success: false, data: nil, error: "Missing required \"description\" string")
            }
            guard let app = NSWorkspace.shared.frontmostApplication else {
                return ToolResultPayload(success: false, data: nil, error: "No frontmost application")
            }

            let appElement = AXUIElementCreateApplication(app.processIdentifier)
            var matches: [(element: AXUIElement, label: String)] = []
            var visited = 0
            collectMatches(appElement, needle: description.lowercased(), depth: 0, visited: &visited, into: &matches)

            if matches.isEmpty {
                return ToolResultPayload(
                    success: false, data: nil,
                    error: "No clickable element matching \"\(description)\" found in \(app.localizedName ?? "the frontmost app")"
                )
            }
            if matches.count > 1 {
                let labels = matches.prefix(5).map { $0.label }.joined(separator: "\", \"")
                return ToolResultPayload(
                    success: false, data: nil,
                    error: "\"\(description)\" matches \(matches.count) elements (e.g. \"\(labels)\") — be more specific"
                )
            }

            let result = AXUIElementPerformAction(matches[0].element, kAXPressAction as CFString)
            guard result == .success else {
                return ToolResultPayload(success: false, data: nil, error: "AXUIElementPerformAction failed (code \(result.rawValue))")
            }
            return ToolResultPayload(success: true, data: AnyCodable(["matched": AnyCodable(matches[0].label)]), error: nil)
        }
    }

    /// Depth- and count-bounded so a pathological accessibility tree
    /// (a huge web view, a misbehaving app) can't hang this tool.
    private static func collectMatches(
        _ element: AXUIElement, needle: String, depth: Int, visited: inout Int, into matches: inout [(element: AXUIElement, label: String)]
    ) {
        if depth > maxDepth || visited > maxElementsVisited || matches.count > 20 { return }
        visited += 1

        for attribute in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute] {
            var value: CFTypeRef?
            guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { continue }
            guard let text = value as? String, !text.isEmpty else { continue }
            if text.lowercased().contains(needle) {
                matches.append((element, text))
                break
            }
        }

        var childrenRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef) == .success,
              let children = childrenRef as? [AXUIElement] else { return }
        for child in children {
            collectMatches(child, needle: needle, depth: depth + 1, visited: &visited, into: &matches)
        }
    }
}
