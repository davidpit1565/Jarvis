// REQUIRES REAL macOS VALIDATION — screen capture permission and the
// `screencapture`/`sips` CLIs' exact runtime behavior cannot be exercised
// outside a real macOS runtime. Never compiled or run in this environment.

import Foundation

/// Captures a screenshot of the full screen and returns the actual image
/// bytes, base64-encoded — unlike `CaptureScreenshotTool`, which saves a
/// full-resolution PNG to disk and returns only a path (see its own doc
/// comment for the "capture vs. deliver" split that exists for). This tool
/// exists for a different, narrower job: letting Core's Orchestrator attach
/// a real image to the model's very next reasoning step (its "Vision
/// Bridge" — see `src/core/orchestrator/screenVisionBridge.ts` on the Core
/// side), so it can genuinely comment on what's on screen right now rather
/// than just knowing a screenshot file exists somewhere.
///
/// Shares `ScreenCaptureCore`'s `screencapture` subprocess logic with
/// `CaptureScreenshotTool` (same TCC/Screen Recording permission
/// requirements — see that tool's own doc comment for the full
/// explanation). What's different here is the output: captured directly as
/// JPEG, then downscaled/recompressed with `sips` so the result comfortably
/// fits under Core's `MAX_IMAGE_BASE64_LENGTH` cap (7,000,000 base64
/// characters) before this tool ever hands bytes back — Core's Orchestrator
/// double-checks the size again on its end as defense in depth, but this
/// tool should never rely on that; an oversized/failed capture here must
/// fail with a clear error, never silently truncate or crash.
///
/// Resize target: 1568px on the longest edge, matching Anthropic's own
/// documented "no further benefit past this size" guidance for Claude
/// vision — larger just costs more tokens/bandwidth for no real quality
/// gain, and a Retina full-screen capture (e.g. 5120x2880) would otherwise
/// be tens of megabytes before any downscaling.
enum LookAtScreenTool {
    private static let timeoutSeconds: TimeInterval = 10
    /// Longest-edge target in pixels — see the type's own doc comment.
    private static let maxDimension = 1568
    /// JPEG quality (0-100) passed to `sips`. Chosen to keep a full-screen
    /// capture comfortably under the base64 cap even on a large Retina
    /// display, while staying legible enough to read on-screen text/UI.
    private static let jpegQuality = 55
    /// Conservative raw-byte ceiling before base64 encoding: Core's cap is
    /// 7,000,000 *base64* characters, and base64 inflates raw bytes by
    /// ~4/3 — this is deliberately well under the math-exact threshold
    /// (~5,250,000 bytes) to leave real headroom rather than cutting it
    /// exactly at the line.
    private static let maxRawBytes = 4_500_000

    static func make() -> AgentTool {
        AgentTool(name: "look_at_screen") { _ in
            let tempDirectory = FileManager.default.temporaryDirectory
            let filename = "jarvis-look-at-screen-\(UUID().uuidString).jpg"
            let destination = tempDirectory.appendingPathComponent(filename)

            // Always try to clean up the temp file, success or failure —
            // this tool's whole point is returning bytes, not leaving a
            // file behind the way CAPTURE_SCREENSHOT deliberately does.
            defer { try? FileManager.default.removeItem(at: destination) }

            do {
                // -x: silent, no "select area" interaction. -t jpg: capture
                // directly as JPEG (smaller starting point than PNG before
                // any resizing happens at all).
                try ScreenCaptureCore.run(args: ["-x", "-t", "jpg"], destination: destination, timeoutSeconds: timeoutSeconds)
            } catch let error as ScreenCaptureCore.CaptureError {
                return ToolResultPayload(success: false, data: nil, error: error.message)
            } catch {
                return ToolResultPayload(success: false, data: nil, error: "screencapture failed: \(error.localizedDescription)")
            }

            guard FileManager.default.fileExists(atPath: destination.path) else {
                return ToolResultPayload(
                    success: false,
                    data: nil,
                    error: "screencapture reported success but produced no image — check Screen Recording permission"
                )
            }

            do {
                try ScreenCaptureCore.resizeAndRecompressJPEG(
                    at: destination,
                    maxDimension: maxDimension,
                    quality: jpegQuality,
                    timeoutSeconds: timeoutSeconds
                )
            } catch let error as ScreenCaptureCore.CaptureError {
                return ToolResultPayload(success: false, data: nil, error: "Failed to downscale screenshot: \(error.message)")
            } catch {
                return ToolResultPayload(success: false, data: nil, error: "Failed to downscale screenshot: \(error.localizedDescription)")
            }

            guard let imageData = try? Data(contentsOf: destination) else {
                return ToolResultPayload(success: false, data: nil, error: "Failed to read captured screenshot from disk")
            }

            guard imageData.count <= maxRawBytes else {
                // Graceful, explicit failure — never silently truncate a
                // JPEG (which would just produce a corrupt/undecodable
                // image) and never crash. This genuinely shouldn't happen
                // given the fixed resize target + quality above, but a
                // future display config (e.g. an unusually wide multi-
                // monitor span) could still in principle exceed it.
                return ToolResultPayload(
                    success: false,
                    data: nil,
                    error: "Captured screenshot is too large (\(imageData.count) bytes) even after downscaling — try again, " +
                        "or ask about a smaller part of the screen"
                )
            }

            let result: [String: AnyCodable] = [
                "mediaType": AnyCodable("image/jpeg"),
                "data": AnyCodable(imageData.base64EncodedString()),
                "sizeBytes": AnyCodable(imageData.count),
            ]
            return ToolResultPayload(success: true, data: AnyCodable(result), error: nil)
        }
    }
}
