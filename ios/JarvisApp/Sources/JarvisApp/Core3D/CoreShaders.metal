// NEVER COMPILED — no Xcode/Metal toolchain in this sandbox. Written
// against RealityKit's CustomMaterial Metal shader API, confirmed real and
// current (non-deprecated, iOS 15.0+) via Apple's own documentation page
// "Modifying RealityKit rendering using custom materials" before writing
// this file — see this task's PR description for the exact pages checked.
//
// WHY RealityKit + CustomMaterial, NOT SceneKit shader modifiers: checked
// first, and SceneKit's SCNShaderModifierEntryPoint (.geometry, .surface,
// .fragment, .lightingModel — every entry point) is marked Deprecated as
// of iOS 26.0 on Apple's own current documentation. Building this app's
// single most visually central, most load-bearing piece of code on an
// API Apple deprecates in the exact OS version this app targets (iOS 26,
// for Liquid Glass) would be a bad technical call now that this is known
// — so this uses RealityKit's CustomMaterial instead, which is NOT
// deprecated (iOS 15.0+, no deprecation banner as of this writing) and
// still gives genuine, real-time, GPU-side (Metal) control over both
// per-vertex geometry and per-fragment surface color — the real
// capability this Core visual needs. RealityKit still renders on Metal
// under the hood, same as SceneKit does, so this is a true "Metal-backed,
// native, non-WebView" renderer either way; the choice here is narrowly
// about which Apple-provided customization layer sits on top of Metal.
//
// HONEST ACCESSOR-NAME UNCERTAINTY — read before assuming this compiles
// as-is: Apple's own public documentation page ("Modifying RealityKit
// rendering using custom materials") confirms, with real code examples,
// only a subset of the exact method names used below:
//   CONFIRMED (appear verbatim in Apple's own examples on that page):
//     params.uniforms().time(), params.geometry().uv0(),
//     params.material_constants().base_color_tint(), params.textures(),
//     params.surface().set_base_color(), params.geometry().set_world_position_offset()
//   REASONED BUT NOT CONFIRMED (no example on that page uses these exact
//   names; they follow the same naming pattern as the confirmed ones
//   above, but that is an inference, not a citation):
//     params.geometry().model_position(), .model_normal(), .view_direction(),
//     params.surface().set_roughness(), .set_metallic(), .set_emissive_color(),
//     and params.uniforms().custom_parameter() for reading back
//     CustomMaterial.Custom's SIMD4<Float> `value` set from Swift.
// Apple publishes a real, authoritative "Custom Shader API" reference PDF
// (developer.apple.com/metal/Metal-RealityKit-APIs.pdf) and the
// <RealityKit/RealityKit.h> header itself that would settle every one of
// these exactly; this sandbox's web access could not open/render that PDF,
// and there is no Xcode here to check the header directly. Check both
// (or just use Xcode's autocomplete on `params.geometry().` / `.surface().`
// / `.uniforms().`) before trusting this file compiles unmodified — treat
// every "reasoned but not confirmed" name above as a likely-right first
// guess to verify, not a fact.

#include <metal_stdlib>
#include <RealityKit/RealityKit.h>

using namespace metal;

// ---------------------------------------------------------------------------
// Shared noise/swirl math
// ---------------------------------------------------------------------------

/// Cheap hash-based pseudo-random value in [0, 1) — there is no built-in
/// noise() in Metal/RealityKit shaders, so every shader that wants organic
/// variation writes its own. Good enough for a handful of large, slow-
/// moving "eye" blobs; not intended as general-purpose high-frequency
/// noise.
inline float coreHash(float3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

/// Smoothed 3D value noise built on `coreHash` (trilinear interpolation
/// over the 8 lattice corners) — enough organic irregularity for the
/// "liquid" look without needing a real Perlin/Simplex implementation.
inline float coreNoise(float3 p) {
    float3 i = floor(p);
    float3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);

    float n000 = coreHash(i + float3(0, 0, 0));
    float n100 = coreHash(i + float3(1, 0, 0));
    float n010 = coreHash(i + float3(0, 1, 0));
    float n110 = coreHash(i + float3(1, 1, 0));
    float n001 = coreHash(i + float3(0, 0, 1));
    float n101 = coreHash(i + float3(1, 0, 1));
    float n011 = coreHash(i + float3(0, 1, 1));
    float n111 = coreHash(i + float3(1, 1, 1));

    float nx00 = mix(n000, n100, f.x);
    float nx10 = mix(n010, n110, f.x);
    float nx01 = mix(n001, n101, f.x);
    float nx11 = mix(n011, n111, f.x);
    float nxy0 = mix(nx00, nx10, f.y);
    float nxy1 = mix(nx01, nx11, f.y);
    return mix(nxy0, nxy1, f.z);
}

/// Fixed spherical-ish positions for the glowing "swirl eyes" distributed
/// across the whole surface — matching the reference image's look (several
/// distinct cyan swirl patches scattered over a chrome sphere), not one
/// confined band. Hand-picked unit vectors, deliberately not evenly
/// spaced (a few close together, a few isolated) so it reads as organic
/// rather than a regular grid pattern.
constant float3 coreEyeCenters[6] = {
    float3( 0.65,  0.55,  0.52),
    float3(-0.70,  0.35,  0.45),
    float3( 0.20, -0.60,  0.70),
    float3(-0.45, -0.50, -0.60),
    float3( 0.75, -0.15, -0.55),
    float3(-0.20,  0.80, -0.40),
};

/// Sums each eye's glow contribution at a given (normalized) surface
/// point, in model space. `time` drives a slow per-eye rotation/pulse so
/// the swirls feel alive and continuously moving (the reference video's
/// quality this is meant to capture), not a static texture. `energy` (0-1,
/// driven by connection/listening/speaking state from Swift — see
/// CoreRealityView.swift) brightens and speeds the swirl without changing
/// its basic character, the same "reacts to real state, never a canned
/// loop" requirement the web Core (`ui/hologram/core.js`) already follows
/// for its own fresnel/specular uniforms.
inline float coreEyeGlow(float3 p, float time, float energy) {
    float glow = 0.0;
    for (int i = 0; i < 6; i++) {
        float3 center = normalize(coreEyeCenters[i]);
        // Each eye drifts slowly around its own base position using noise
        // offset by its own index (so they don't all move in lockstep) —
        // "alive," not "orbiting on rails."
        float driftTime = time * (0.08 + 0.015 * float(i));
        float3 drift = float3(
            coreNoise(float3(float(i) * 11.0, driftTime, 0.0)) - 0.5,
            coreNoise(float3(float(i) * 7.0, driftTime, 5.0)) - 0.5,
            coreNoise(float3(float(i) * 3.0, driftTime, 9.0)) - 0.5
        ) * 0.25;
        float3 wobbly = normalize(center + drift);

        float d = distance(p, wobbly);
        // Swirl ring shape: brightest in a thin band at radius ~0.22,
        // fading both toward the center and outward — an "eye"/iris look
        // rather than a solid blob, echoing the reference image's ringed
        // swirl pattern.
        float ring = 1.0 - smoothstep(0.0, 0.42, abs(d - 0.22));
        float swirlDetail = coreNoise(p * 6.0 + float3(0.0, 0.0, driftTime * 2.0));
        glow += ring * (0.6 + 0.4 * swirlDetail);
    }
    return saturate(glow) * (0.5 + 0.7 * energy);
}

// ---------------------------------------------------------------------------
// Geometry modifier: gentle organic surface displacement
// ---------------------------------------------------------------------------

[[visible]]
void jarvisCoreGeometryModifier(realitykit::geometry_parameters params) {
    float3 modelPosition = params.geometry().model_position();
    float3 normalDir = normalize(params.geometry().model_normal());
    float time = params.uniforms().time();

    // Low-amplitude, low-frequency displacement along the normal — the
    // "liquid," continuously-shifting surface from the reference video,
    // kept deliberately subtle (the reference image itself is a fairly
    // smooth sphere; the swirls are a surface COLOR pattern, not deep
    // geometric dents) so it reads as alive without losing the sphere's
    // basic silhouette.
    float displacement = coreNoise(modelPosition * 1.6 + float3(0.0, 0.0, time * 0.12)) - 0.5;
    float3 offset = normalDir * displacement * 0.025;
    params.geometry().set_model_position_offset(offset);
}

// ---------------------------------------------------------------------------
// Surface shader: liquid-chrome base + distributed glowing cyan swirls
// ---------------------------------------------------------------------------

[[visible]]
void jarvisCoreSurfaceShader(realitykit::surface_parameters params) {
    float3 modelPosition = params.geometry().model_position();
    float3 normalDir = normalize(params.geometry().model_normal());
    float3 viewDir = normalize(params.geometry().view_direction());
    float time = params.uniforms().time();

    // See this file's header comment: `custom_parameter()`'s exact name is
    // an educated guess, not a confirmed one. `.xyz` here is
    // (energy, audioLevel, warp) set from Swift via CustomMaterial.Custom's
    // SIMD4<Float> `value` — see CoreRealityView.swift's `updateUniforms`.
    float4 custom = params.uniforms().custom_parameter();
    float energy = custom.x;
    float audioLevel = custom.y;

    // Fresnel term: near-grazing angles (edge of the sphere, as seen by
    // the camera) get brighter/more reflective — the core of the "liquid
    // chrome" look, same physical idea (and similar exponent) as the web
    // Core's own fresnel term in `ui/hologram/core.js`.
    float ndotv = saturate(dot(normalDir, viewDir));
    float fresnel = pow(1.0 - ndotv, 2.2);

    // Base chrome: a near-white/cool-gray metal, darker toward the center
    // of each visible face so it doesn't read as a flat matte gray —
    // approximates an environment reflection without an actual reflection
    // probe/cubemap (none is set up in this first pass — a real chrome
    // "look" ultimately wants one; see this file's own follow-up note
    // below).
    float3 chromeBase = mix(float3(0.22, 0.24, 0.27), float3(0.85, 0.88, 0.92), fresnel);

    // Distributed glowing cyan swirls ("eyes"), per coreEyeGlow above.
    float glow = coreEyeGlow(normalize(modelPosition), time, saturate(energy + audioLevel * 0.5));
    float3 swirlColor = float3(0.25, 0.85, 1.0); // cyan-blue, matching the reference image

    float3 baseColor = mix(chromeBase, swirlColor, glow);

    // Specular sweep: a bright, narrow highlight that slowly travels
    // across the surface over time, layered on top of fresnel — the
    // "sharp specular highlights" the reference image shows.
    float sweep = pow(saturate(dot(normalDir, normalize(float3(sin(time * 0.3), 0.6, cos(time * 0.3))))), 24.0);
    baseColor += float3(1.0) * sweep * 0.8;

    params.surface().set_base_color(half3(baseColor));
    params.surface().set_roughness(half(0.12));
    params.surface().set_metallic(half(0.85));
    params.surface().set_emissive_color(half3(swirlColor * glow * (0.6 + 0.6 * energy)));

    // FOLLOW-UP NOTE (not built here): a real chrome material reads
    // strongest with an actual reflection — RealityKit's image-based
    // lighting (an .hdr/.skybox environment, or
    // EnvironmentResource) would make this look substantially more like
    // the reference photo than fresnel/specular math alone ever can.
    // Deliberately out of scope for this first pass (needs a real
    // environment asset + real device testing to tune), but the surface
    // shader above is structured so adding `set_specular()`/environment
    // sampling later is additive, not a rewrite.
}
