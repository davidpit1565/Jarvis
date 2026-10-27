// NEVER COMPILED OR RUN — no Xcode/iOS toolchain in this sandbox.

import AVFoundation
import SwiftUI

/// Bridges `AVCaptureVideoPreviewLayer` (UIKit/AVFoundation) into SwiftUI.
/// `UIViewRepresentable` + a `CALayer`-backed `UIView` is the standard,
/// real, current way to show a live `AVCaptureSession` preview in SwiftUI
/// — there is no native SwiftUI view for this as of this writing.
struct CameraPreviewView: UIViewRepresentable {
    let session: AVCaptureSession

    final class PreviewUIView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }

    func makeUIView(context: Context) -> PreviewUIView {
        let view = PreviewUIView()
        view.previewLayer.session = session
        view.previewLayer.videoGravity = .resizeAspectFill
        view.backgroundColor = .black
        return view
    }

    func updateUIView(_ uiView: PreviewUIView, context: Context) {
        // Nothing to update per-render today — the session reference never
        // changes for the lifetime of this view. A camera-flip control
        // (front/back) would tear down and reconfigure `session`'s input
        // in CameraController, not here.
    }
}
