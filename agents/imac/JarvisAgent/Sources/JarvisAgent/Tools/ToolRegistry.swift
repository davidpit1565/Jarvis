// REQUIRES REAL macOS VALIDATION — never compiled or run in this environment.

import Foundation

/// A tool this Agent can actually execute. There is deliberately no
/// generic "run this shell command" or "run this AppleScript" variant —
/// every capability is a named Swift function registered here at compile
/// time. Even if Core were compromised or sent an unregistered tool name,
/// there is no code path that could execute it: `execute` only ever runs
/// a function this table already knows about.
struct AgentTool {
    let name: String
    let execute: ([String: AnyCodable]) -> ToolResultPayload
}

/// The Agent's own tool allowlist — the second half of Phase 2's defense
/// in depth. Core's ToolRegistry + PermissionService decide whether a
/// tool call is authorized at all; this registry decides, independently,
/// whether *this device* is even capable of running it. A tool name Core
/// doesn't recognize never reaches here; a tool name this Agent doesn't
/// recognize is rejected here regardless of what Core sent.
final class AgentToolRegistry {
    private var tools: [String: AgentTool] = [:]

    func register(_ tool: AgentTool) {
        tools[tool.name] = tool
    }

    func execute(name: String, input: [String: AnyCodable]) -> ToolResultPayload {
        guard let tool = tools[name] else {
            return ToolResultPayload(success: false, data: nil, error: "Unknown tool on this Agent: \(name)")
        }
        return tool.execute(input)
    }

    static func buildDefault() -> AgentToolRegistry {
        let registry = AgentToolRegistry()
        registry.register(GetActiveApplicationTool.make())
        registry.register(OpenApplicationTool.make())
        registry.register(QuitApplicationTool.make())
        registry.register(OpenUrlTool.make())
        return registry
    }
}
