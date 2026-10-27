// NEVER COMPILED OR RUN — no Xcode/iOS toolchain in this sandbox.
//
// WHAT'S LITERALLY ON SCREEN: a full-screen live camera preview
// (`CameraPreviewView`, front camera by default — see
// `CameraController.swift`'s doc comment on why front) with a single
// glass circular close button floating in the top-right safe area, and a
// glass status pill at the bottom while permission is pending/denied
// (e.g. "Requesting camera access…" / "Camera access denied — enable it
// in Settings"). Camera permission is requested the moment this view
// appears (`cameraController.open()`), matching "open the camera" meaning
// right now, not pre-authorized at app launch. Dismissing this view (the
// close button, or Core sending CLOSE_CAMERA while it's open — see
// `CameraController.close()`) tears the capture session down; it is never
// left running once this view isn't visible.

import SwiftUI

struct CameraSheetView: View {
    @ObservedObject var cameraController: CameraController
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if cameraController.isOpen {
                CameraPreviewView(session: cameraController.captureSession)
                    .ignoresSafeArea()
            }

            VStack {
                HStack {
                    Spacer()
                    Button {
                        cameraController.close()
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                            .foregroundStyle(.white)
                            .frame(width: 44, height: 44)
                    }
                    .glassEffect(.regular, in: Circle())
                    .padding()
                }
                Spacer()
                if let statusMessage = cameraController.statusMessage {
                    Text(statusMessage)
                        .font(.footnote)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .glassEffect(.regular, in: Capsule())
                        .padding(.bottom, 32)
                }
            }
        }
        .onAppear {
            cameraController.open()
        }
        .onDisappear {
            cameraController.close()
        }
    }
}
