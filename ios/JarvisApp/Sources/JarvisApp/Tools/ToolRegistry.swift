// NEVER COMPILED OR RUN — no Xcode/iOS toolchain in this sandbox.

import Foundation

/// A tool this app can actually execute. Same deliberate design as the Mac
/// agent's `AgentTool`/`AgentToolRegistry` (see its own doc comment in
/// `agents/imac/JarvisAgent/Sources/JarvisAgent/Tools/ToolRegistry.swift`):
/// there is no generic "run this" entry point — every capability is a
/// named Swift function registered here at compile time. This is the same
/// "named, compiled-in tools only" philosophy the task's own instructions
/// call out explicitly; this app does not reinvent it.
struct AgentTool {
    let name: String
    let execute: ([String: AnyCodable]) -> ToolResultPayload
}

/// This app's own tool allowlist — the iPhone counterpart to
/// `AgentToolRegistry` on the Mac agent. Deliberately starts minimal: only
/// the camera open/close tools exist today (see `CameraTools.swift`).
/// `tests/security/agentToolParity.test.ts` on the Core side checks that
/// every Core device tool (`target: "device"`) has a matching registered
/// name in EITHER this file or the Mac agent's — a tool genuinely scoped
/// to one platform (like the camera tools, iPhone-only today) only needs
/// to exist on the platform it actually applies to.
final class AgentToolRegistry {
    private var tools: [String: AgentTool] = [:]

    func register(_ tool: AgentTool) {
        tools[tool.name] = tool
    }

    /// Every tool this app can actually run, for the capability list sent
    /// in `device.register` — derived from the registry so the two can't
    /// drift, same reasoning as the Mac agent's identical property.
    var toolNames: [String] {
        tools.keys.sorted()
    }

    func execute(name: String, input: [String: AnyCodable]) -> ToolResultPayload {
        guard let tool = tools[name] else {
            return ToolResultPayload(success: false, data: nil, error: "Unknown tool on this device: \(name)")
        }
        return tool.execute(input)
    }

    static func buildDefault(cameraController: CameraController) -> AgentToolRegistry {
        let registry = AgentToolRegistry()
        registry.register(OpenCameraTool.make(cameraController: cameraController))
        registry.register(CloseCameraTool.make(cameraController: cameraController))
        return registry
    }
}
