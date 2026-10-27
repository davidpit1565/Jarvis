// NEVER COMPILED OR RUN — no Xcode/iOS toolchain in this sandbox. Written
// against real, current AVFoundation API names/signatures as of iOS 17+;
// never exercised against a real camera, a real permission prompt, or a
// real device. JARVIS's first camera capability anywhere in this
// codebase — confirmed via grep before writing this (nothing like it
// exists on the Mac agent or Core today).
//
// Architecture note for whoever adds "what do you see" vision analysis
// next (explicitly NOT built here — see OpenCameraTool.ts's doc comment):
// `captureStillFrame(completion:)` below is the seam to extend. It is not
// wired to anything today; it exists so a future vision hookup is "call
// this and send the JPEG to Core," not "restructure this controller."

import AVFoundation
import Combine
import UIKit

/// Owns the live AVCaptureSession behind "open the camera" / "close the
/// camera." Deliberately on-demand only: permission is requested the
/// moment `open()` is first called, never at app launch (this is the one
/// capability in this app that must NOT be pre-authorized — see the task's
/// own instructions on this point).
///
/// `@MainActor`-ish by convention (every method here is expected to be
/// called from, and updates `@Published` state on, the main actor) even
/// though AVCaptureSession's own configuration calls are documented to run
/// on a dedicated session queue in a fully production-hardened
/// implementation — this first pass keeps session start/stop directly on
/// the main thread for simplicity, matching this task's explicit "first
/// real app skeleton, not a feature-complete release" scope. A real device
/// test may well surface a brief main-thread hitch on `startRunning()`
/// (Apple's own docs note it's a blocking call) worth moving to a
/// background queue once this is actually running on hardware.
final class CameraController: NSObject, ObservableObject {
    enum PermissionState {
        case notDetermined
        case granted
        case denied
        case restricted
    }

    @Published private(set) var isOpen = false
    @Published private(set) var permissionState: PermissionState = .notDetermined
    /// Set when `open()` is called but the camera isn't actually running
    /// yet (permission prompt in flight, or just denied) — lets
    /// `CameraSheetView` show something other than a blank black screen.
    @Published private(set) var statusMessage: String?

    private let session = AVCaptureSession()
    /// Front camera by default: the two concrete examples David gave
    /// ("does this fit me," "what do you think of this") both read as
    /// looking at yourself through the phone the way you'd use a mirror,
    /// not pointing the phone away. No UI to flip to the back camera yet
    /// — a reasonable, cheap follow-up, not built in this first pass.
    private var currentPosition: AVCaptureDevice.Position = .front
    private var videoInput: AVCaptureDeviceInput?
    private let sessionQueue = DispatchQueue(label: "com.jarvis.app.camera.session")

    /// Exposed for `CameraPreviewView` (a `UIViewRepresentable`) to attach
    /// an `AVCaptureVideoPreviewLayer` to the same running session.
    var captureSession: AVCaptureSession { session }

    func open() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            startSession()
        case .notDetermined:
            statusMessage = "Requesting camera access…"
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.permissionState = granted ? .granted : .denied
                    if granted {
                        self.startSession()
                    } else {
                        self.statusMessage = "Camera access denied — enable it in Settings to use this."
                    }
                }
            }
        case .denied:
            permissionState = .denied
            statusMessage = "Camera access denied — enable it in Settings to use this."
        case .restricted:
            permissionState = .restricted
            statusMessage = "Camera access is restricted on this device."
        @unknown default:
            statusMessage = "Camera access state unknown."
        }
    }

    func close() {
        guard isOpen else { return }
        sessionQueue.async { [weak self] in
            self?.session.stopRunning()
        }
        isOpen = false
        statusMessage = nil
    }

    private func startSession() {
        permissionState = .granted
        statusMessage = "Starting camera…"
        sessionQueue.async { [weak self] in
            guard let self else { return }
            self.configureSessionIfNeeded()
            self.session.startRunning()
            DispatchQueue.main.async {
                self.isOpen = true
                self.statusMessage = nil
            }
        }
    }

    /// Configures inputs/outputs once; safe to call repeatedly (no-ops if
    /// already configured for the current `currentPosition`).
    private func configureSessionIfNeeded() {
        guard videoInput == nil else { return }

        session.beginConfiguration()
        session.sessionPreset = .high

        guard
            let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: currentPosition),
            let input = try? AVCaptureDeviceInput(device: device),
            session.canAddInput(input)
        else {
            Logger.error("CameraController: failed to configure video input")
            session.commitConfiguration()
            return
        }

        session.addInput(input)
        videoInput = input
        session.commitConfiguration()
    }

    /// Seam for a future "what do you see" vision hookup — captures one
    /// still frame as JPEG data and hands it back. NOT called anywhere in
    /// this first pass; see this file's header comment.
    func captureStillFrame(completion: @escaping (Data?) -> Void) {
        // Deliberately unimplemented: wiring a real AVCapturePhotoOutput
        // here without ever being able to exercise it on a real session
        // would be guessing at a capability nobody asked for yet. The
        // `AVCaptureSession`/`videoInput` plumbing above is already shaped
        // so adding an `AVCapturePhotoOutput` + `AVCapturePhotoCaptureDelegate`
        // is additive, not a restructure.
        completion(nil)
    }
}
