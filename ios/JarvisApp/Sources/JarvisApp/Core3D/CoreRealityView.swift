// NEVER COMPILED OR RUN — no Xcode/iOS/Metal toolchain in this sandbox.
// See CoreShaders.metal's header comment for the full reasoning on why
// RealityKit + CustomMaterial was chosen over SceneKit (whose shader
// modifiers are deprecated as of iOS 26) and for exactly which Metal-side
// accessor names are confirmed vs. reasoned-but-unverified.

import Metal
import RealityKit
import SwiftUI

/// Drives the Core's reactive "energy" from real app state — never a
/// canned/looping animation pretending to be reactive, per the task's own
/// explicit requirement. `connected` false reads as a dim, barely-glowing
/// sphere (nothing to show yet); `listening` and `speaking` each push
/// energy up; `audioLevel` (0-1, driven by the live microphone level while
/// listening — NOT built as a real level meter in this first pass, see the
/// TODO in `energy` below) would add fine-grained reactivity once wired.
struct CoreVisualState: Equatable {
    var connected = false
    var listening = false
    var speaking = false
    var audioLevel: Float = 0

    /// Combined 0-1 "how alive should this look right now" signal fed to
    /// the shader's `energy` uniform.
    var energy: Float {
        guard connected else { return 0.12 }
        if speaking { return 0.9 }
        if listening { return 0.55 + audioLevel * 0.4 }
        return 0.3
    }
}

/// SwiftUI wrapper around a RealityKit `RealityView` hosting one sphere
/// `ModelEntity` with the custom liquid-chrome/swirl material from
/// `CoreShaders.metal`. This is the dominant visual element of the app's
/// primary screen (`RootView.swift`) — not a decorative corner element.
struct CoreRealityView: View {
    let state: CoreVisualState

    var body: some View {
        RealityView { content in
            let sphere = ModelEntity(mesh: .generateSphere(radius: 0.5))
            sphere.name = "jarvis-core"

            if let material = Self.makeCoreMaterial() {
                sphere.model?.materials = [material]
            } else {
                // Confirmed-safe fallback if shader loading fails (e.g. a
                // real build environment where the .metal file wasn't
                // compiled into the default library correctly) — a plain
                // metallic sphere rather than an invisible/crashing view.
                // Never silently shows nothing: CoreShaders.metal
                // compiling cleanly is unverified in this sandbox, so this
                // fallback is a real, load-bearing safety net, not
                // defensive boilerplate.
                var fallback = PhysicallyBasedMaterial()
                fallback.baseColor = .init(tint: .init(white: 0.5, alpha: 1))
                fallback.metallic = .init(floatLiteral: 0.8)
                fallback.roughness = .init(floatLiteral: 0.2)
                sphere.model?.materials = [fallback]
            }

            content.add(sphere)

            // A non-AR RealityView on iOS has no default camera the way
            // visionOS's shared space does — add an explicit
            // PerspectiveCamera so the sphere is actually framed. This
            // positioning (camera a short distance back along +Z, looking
            // at the origin where the sphere sits) is a reasoned starting
            // point, not tuned against a real render.
            let camera = PerspectiveCamera()
            camera.position = [0, 0, 1.6]
            content.add(camera)

            // A couple of simple point lights so the metallic material has
            // something real to reflect/highlight beyond the shader's own
            // emissive swirls — a true chrome look ultimately wants image-
            // based lighting (see CoreShaders.metal's own follow-up note),
            // not built here.
            let keyLight = PointLight()
            keyLight.light.intensity = 6000
            keyLight.position = [0.8, 0.8, 1.2]
            content.add(keyLight)

            let rimLight = PointLight()
            rimLight.light.intensity = 3000
            rimLight.position = [-1.0, -0.4, 0.6]
            content.add(rimLight)
        } update: { content in
            guard let sphere = content.entities.first(where: { $0.name == "jarvis-core" }) as? ModelEntity else {
                return
            }
            Self.updateUniforms(on: sphere, state: state)
        }
        .background(Color.black)
    }

    /// Builds the CustomMaterial from the compiled Metal functions. Returns
    /// nil (triggering the plain-material fallback above) if the default
    /// Metal library or either named function can't be found — e.g. if
    /// CoreShaders.metal didn't compile into the app's default library for
    /// any reason. This is exactly the kind of failure that can only be
    /// discovered on a real build; never verified in this sandbox.
    private static func makeCoreMaterial() -> CustomMaterial? {
        guard let device = MTLCreateSystemDefaultDevice(),
              let library = device.makeDefaultLibrary()
        else { return nil }

        let geometryModifier = CustomMaterial.GeometryModifier(named: "jarvisCoreGeometryModifier", in: library)
        let surfaceShader = CustomMaterial.SurfaceShader(named: "jarvisCoreSurfaceShader", in: library)

        return try? CustomMaterial(surfaceShader: surfaceShader, geometryModifier: geometryModifier, lightingModel: .lit)
    }

    /// Pushes `state.energy` (plus audio level / a reserved third "warp"
    /// slot, currently 0) into the material's custom uniform vector — see
    /// CoreShaders.metal's header comment on `custom_parameter()`'s
    /// unconfirmed exact Metal-side name.
    private static func updateUniforms(on sphere: ModelEntity, state: CoreVisualState) {
        guard var material = sphere.model?.materials.first as? CustomMaterial else { return }
        material.custom = .init(value: SIMD4<Float>(state.energy, state.audioLevel, 0, 0), texture: nil)
        sphere.model?.materials = [material]
    }
}
