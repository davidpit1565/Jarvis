// REQUIRES REAL macOS VALIDATION — screen capture permission and the
// `screencapture` CLI's exact runtime behavior cannot be exercised
// outside a real macOS runtime. Never compiled or run in this
// environment.

import Foundation

/// Captures the full screen (all displays, no window picker — see below)
/// via the `screencapture` system binary and saves it as a PNG under the
/// device's "Jarvis" folder (one of `FileAccessPolicy.allowedRoots()`),
/// so the resulting path can be handed to `read_file_bytes` and then
/// `share_file_to_phone` to actually deliver it. This tool only returns a
/// path/filename/size — never the image bytes themselves — the same
/// capture-vs-deliver split `ListRecentPhotosTool` already uses, kept
/// deliberately simple rather than building a combined
/// capture-then-upload tool: Core already composes `read_file_bytes` +
/// `share_file_to_phone` for any file, and CAPTURE_SCREENSHOT just needs
/// to join that existing chain as a third first step, not duplicate it.
///
/// ## Capture approach: `screencapture` CLI, not CGWindowListCreateImage/
/// ScreenCaptureKit
///
/// Shelling out to `/usr/sbin/screencapture` was chosen over calling a
/// screen-capture API directly for simplicity: it's a single
/// Apple-maintained system binary, needs no extra linking (ScreenCaptureKit
/// in particular is a much larger API surface for "take one screenshot"),
/// and already handles multi-display composition on its own.
///
/// **This does NOT avoid needing the Screen Recording permission** — don't
/// assume shelling out sidesteps it. Verified against current Apple
/// documentation: since macOS 10.15 Catalina, TCC enforces Screen
/// Recording consent against the *responsible process* for a capture. When
/// `screencapture` runs as a child process of this agent (via `Process`),
/// JarvisAgent itself is attributed as the responsible process and is what
/// the system prompts for and checks — not `screencapture`'s own binary
/// identity. So this agent needs Screen Recording access granted
/// explicitly in System Settings → Privacy & Security → Screen Recording,
/// the same one-time setup step already required for Accessibility
/// (`ClickElementTool`). The upside of the CLI over calling the API
/// in-process is purely implementation simplicity, not permission
/// avoidance.
///
/// No "active window only" mode: `screencapture -w` requires an
/// interactive click to pick the window, which a background `launchd`
/// agent can't provide — left unbuilt rather than shipped half-working,
/// per the task's own "don't over-engineer" guidance. Full-screen alone
/// covers "take a screenshot and send it to my phone."
///
/// REQUIRES REAL VALIDATION: confirm on David's actual Mac that (a) the
/// Screen Recording permission prompt actually appears the first time
/// this runs, (b) a capture attempted before granting it fails with a
/// clear non-zero exit code / error rather than silently writing a blank
/// or all-black image, and (c) the agent process (not some other
/// Terminal/process) is what macOS lists under Screen Recording once
/// granted.
enum CaptureScreenshotTool {
    private static let timeoutSeconds: TimeInterval = 10

    static func make() -> AgentTool {
        AgentTool(name: "capture_screenshot") { _ in
            guard let jarvisFolder = FileAccessPolicy.allowedRoots().first(where: { $0.lastPathComponent == "Jarvis" }) else {
                return ToolResultPayload(success: false, data: nil, error: "Jarvis folder not available")
            }

            let fileManager = FileManager.default
            if !fileManager.fileExists(atPath: jarvisFolder.path) {
                do {
                    try fileManager.createDirectory(at: jarvisFolder, withIntermediateDirectories: true)
                } catch {
                    return ToolResultPayload(success: false, data: nil, error: "Failed to create Jarvis folder: \(error.localizedDescription)")
                }
            }

            let formatter = DateFormatter()
            formatter.dateFormat = "yyyy-MM-dd-HHmmss-SSS"
            let filename = "jarvis-screenshot-\(formatter.string(from: Date())).png"
            let destination = jarvisFolder.appendingPathComponent(filename)

            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
            // -x: silent (no camera shutter sound/flash) and skips the
            // "select area" interaction — full-screen, all displays.
            process.arguments = ["-x", destination.path]

            let stderrPipe = Pipe()
            process.standardError = stderrPipe

            // Same async-completion-via-semaphore idiom ListRecentPhotosTool
            // uses for PHPhotoLibrary.requestAuthorization — AgentTool.execute
            // is synchronous, so a blocking wait with a timeout is how this
            // registry's tools bridge an async/subprocess completion back.
            let semaphore = DispatchSemaphore(value: 0)
            process.terminationHandler = { _ in semaphore.signal() }

            do {
                try process.run()
            } catch {
                return ToolResultPayload(success: false, data: nil, error: "Failed to launch screencapture: \(error.localizedDescription)")
            }

            if semaphore.wait(timeout: .now() + timeoutSeconds) == .timedOut {
                process.terminate()
                return ToolResultPayload(success: false, data: nil, error: "screencapture timed out after \(Int(timeoutSeconds))s")
            }

            guard process.terminationStatus == 0 else {
                let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
                let stderrText = String(data: stderrData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                return ToolResultPayload(
                    success: false,
                    data: nil,
                    error: "screencapture exited with status \(process.terminationStatus)" +
                        (stderrText.isEmpty ? "" : ": \(stderrText)") +
                        " — check that Screen Recording permission is granted to JarvisAgent in System Settings"
                )
            }

            guard fileManager.fileExists(atPath: destination.path),
                  let attributes = try? fileManager.attributesOfItem(atPath: destination.path),
                  let sizeBytes = attributes[.size] as? Int, sizeBytes > 0
            else {
                return ToolResultPayload(
                    success: false,
                    data: nil,
                    error: "screencapture reported success but produced no image — check Screen Recording permission"
                )
            }

            // Returned relative to home (same convention read_file_bytes's
            // `path` input takes) so the model can pass this straight back
            // into read_file_bytes without reconstructing it.
            let result: [String: AnyCodable] = [
                "path": AnyCodable("Jarvis/\(filename)"),
                "filename": AnyCodable(filename),
                "sizeBytes": AnyCodable(sizeBytes),
            ]
            return ToolResultPayload(success: true, data: AnyCodable(result), error: nil)
        }
    }
}
