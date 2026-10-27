// NEVER COMPILED OR RUN — no Xcode/iOS toolchain in this sandbox.
//
// Device-side implementation of Core's OPEN_CAMERA/CLOSE_CAMERA device
// tools (src/tools/system/OpenCameraTool.ts, CloseCameraTool.ts). This is
// JARVIS's first real camera capability anywhere in the codebase — see
// those two files' doc comments for the full reasoning on scope/
// permission tier. Both tools dispatch to the same `CameraController`
// the live camera UI itself observes (`Camera/CameraController.swift`),
// so a tool-driven open/close and a manual UI close end up in the exact
// same place — there is no separate "tool state" to drift from "UI
// state."

import Foundation

enum OpenCameraTool {
    /// Requests camera permission at the moment this runs (if not already
    /// granted/denied) and starts the capture session — see
    /// `CameraController.open()` for the permission-timing details. This
    /// closure runs on an arbitrary queue (same as every `AgentTool`); the
    /// actual AVCaptureSession/UI work it kicks off hops to the main
    /// actor internally, matching `CameraController`'s own threading
    /// contract.
    static func make(cameraController: CameraController) -> AgentTool {
        AgentTool(name: "open_camera") { _ in
            // Camera permission is asked for asynchronously, and a tool
            // call must answer synchronously with *something* (there is
            // no "pending" ToolResultPayload state in this protocol) — so
            // this reports success as soon as the open request is
            // accepted and kicked off, not once the session is actually
            // running or a permission prompt has been answered. The UI
            // itself (`CameraSheetView`) is the real source of truth for
            // whether the feed is actually visible; a denied permission
            // surfaces there (an explanatory message), not as a failed
            // tool.result here. This mirrors how CAPTURE_SCREENSHOT on
            // the Mac agent can't synchronously know whether Screen
            // Recording permission is granted before macOS's own
            // `screencapture` call returns either — asynchronicity across
            // a real OS permission prompt is a genuine, shared constraint,
            // not something unique to this tool.
            cameraController.open()
            let result: [String: AnyCodable] = [
                "opened": AnyCodable(true),
            ]
            return ToolResultPayload(success: true, data: AnyCodable(result), error: nil)
        }
    }
}

enum CloseCameraTool {
    static func make(cameraController: CameraController) -> AgentTool {
        AgentTool(name: "close_camera") { _ in
            cameraController.close()
            let result: [String: AnyCodable] = [
                "closed": AnyCodable(true),
            ]
            return ToolResultPayload(success: true, data: AnyCodable(result), error: nil)
        }
    }
}
