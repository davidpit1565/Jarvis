// REQUIRES REAL macOS VALIDATION — the `screencapture`/`sips` CLIs' exact
// runtime behavior cannot be exercised outside a real macOS runtime. Never
// compiled or run in this environment.

import Foundation

/// Shared `screencapture` subprocess invocation used by both
/// CaptureScreenshotTool (saves a full-resolution PNG, returns only a path)
/// and LookAtScreenTool (captures a downscaled JPEG and returns the actual
/// bytes for a real vision call) — see each tool's own doc comment for why
/// they stay two separate tools rather than one combined capture-and-return
/// tool. Pulled out here purely to avoid duplicating the subprocess/timeout/
/// error-handling logic itself, since the underlying `screencapture`
/// behavior (and the Screen Recording TCC permission it requires — see
/// CaptureScreenshotTool's own doc comment for the full explanation of why
/// shelling out doesn't avoid that permission) is identical for both.
enum ScreenCaptureCore {
    struct CaptureError: Error {
        let message: String
    }

    /// Runs `/usr/sbin/screencapture` with `args + [destination.path]` and
    /// waits (bounded by `timeoutSeconds`) for it to exit, throwing a clear
    /// `CaptureError` on launch failure, timeout, or non-zero exit — never
    /// silently leaving a blank/missing file for the caller to discover.
    static func run(args: [String], destination: URL, timeoutSeconds: TimeInterval = 10) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        process.arguments = args + [destination.path]

        let stderrPipe = Pipe()
        process.standardError = stderrPipe

        // Same async-completion-via-semaphore idiom used throughout this
        // registry's tools to bridge a synchronous `AgentTool.execute` with
        // an async subprocess completion.
        let semaphore = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in semaphore.signal() }

        do {
            try process.run()
        } catch {
            throw CaptureError(message: "Failed to launch screencapture: \(error.localizedDescription)")
        }

        if semaphore.wait(timeout: .now() + timeoutSeconds) == .timedOut {
            process.terminate()
            throw CaptureError(message: "screencapture timed out after \(Int(timeoutSeconds))s")
        }

        guard process.terminationStatus == 0 else {
            let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
            let stderrText = String(data: stderrData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            throw CaptureError(
                message: "screencapture exited with status \(process.terminationStatus)" +
                    (stderrText.isEmpty ? "" : ": \(stderrText)") +
                    " — check that Screen Recording permission is granted to JarvisAgent in System Settings"
            )
        }
    }

    /// Runs `/usr/bin/sips` (Apple's built-in scriptable image processor) to
    /// resize `source`'s longest edge down to `maxDimension` pixels and
    /// recompress it as JPEG at `quality` (0-100), in place. Used only by
    /// LookAtScreenTool — CaptureScreenshotTool's own full-resolution PNG is
    /// deliberately left untouched, since its whole point is an unmodified
    /// screenshot saved for the user. `sips` (like `screencapture`) is a
    /// single Apple-maintained system binary, so this needs no extra
    /// linking or image-processing library.
    static func resizeAndRecompressJPEG(at path: URL, maxDimension: Int, quality: Int, timeoutSeconds: TimeInterval = 10) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/sips")
        process.arguments = [
            "-Z", String(maxDimension),
            "-s", "format", "jpeg",
            "-s", "formatOptions", String(quality),
            path.path,
            "--out", path.path,
        ]

        let stderrPipe = Pipe()
        process.standardError = stderrPipe

        let semaphore = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in semaphore.signal() }

        do {
            try process.run()
        } catch {
            throw CaptureError(message: "Failed to launch sips: \(error.localizedDescription)")
        }

        if semaphore.wait(timeout: .now() + timeoutSeconds) == .timedOut {
            process.terminate()
            throw CaptureError(message: "sips timed out after \(Int(timeoutSeconds))s")
        }

        guard process.terminationStatus == 0 else {
            let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
            let stderrText = String(data: stderrData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            throw CaptureError(
                message: "sips exited with status \(process.terminationStatus)" + (stderrText.isEmpty ? "" : ": \(stderrText)")
            )
        }
    }
}
