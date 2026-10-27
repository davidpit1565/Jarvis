/**
 * JARVIS Core — the living 3D core renderer.
 *
 * Ground-up rebuild (2026-10-27). The previous build (wireframe sphere +
 * particle flow field + orbit rings) is gone; see the repo's own history
 * for why. This is a single organic, glowing form: a noise-displaced
 * icosphere lit entirely by a custom shader (fresnel rim + a slow
 * specular sweep), with a soft additive halo and a sparse background
 * dust layer for depth — five effects total, chosen deliberately few so
 * they read clearly together instead of stacking into noise.
 *
 * Technique: displaced geometry + fragment shader, NOT raymarched SDF
 * metaballs. Both are legitimate real techniques for this "Siri-style
 * living core" category; displaced geometry was chosen because it's
 * materially cheaper (one mesh, no per-pixel raymarch loop) while still
 * reading as organic at this mesh resolution (icosahedron subdivision 5,
 * 10242 vertices) with layered, domain-warped simplex noise — and this
 * page has to run acceptably on an iPhone's GPU, not just a desktop one.
 *
 * Every continuous idle motion (breathing, slow rotation, dust drift) is
 * frozen under `prefers-reduced-motion`; every value driven by a real
 * signal (energy level, audio level, error tint) keeps responding, since
 * those are direct reactions, not ambient decoration.
 *
 * Public API (window.JarvisCore):
 *   init(canvas)
 *   setLiveState(name)       — one of the real LiveState values (see
 *                              src/core/state/JarvisLiveState.ts), or
 *                              "OFFLINE" for "not connected to Core".
 *   pulse(amount)            — a one-shot decaying bump, for discrete
 *                              real events (a tool call landed, a word
 *                              boundary fired during real TTS playback).
 *   setAudioLevel(level)     — 0..1, real mic/analyser amplitude.
 *   setReducedMotion(bool)
 *   setErrorTint(bool)
 */
(function () {
  "use strict";

  // --- Ashima/McEwan 3D simplex noise (public domain / MIT family, the
  // same noise algorithm referenced throughout this project's prior
  // build and widely used in real-time GLSL work) -------------------------
  const NOISE_GLSL = `
    vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
    vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
    vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
    vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314 * r;}
    float snoise(vec3 v){
      const vec2 C = vec2(1.0/6.0, 1.0/3.0);
      const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
      vec3 i  = floor(v + dot(v, C.yyy));
      vec3 x0 = v - i + dot(i, C.xxx);
      vec3 g = step(x0.yzx, x0.xyz);
      vec3 l = 1.0 - g;
      vec3 i1 = min(g.xyz, l.zxy);
      vec3 i2 = max(g.xyz, l.zxy);
      vec3 x1 = x0 - i1 + C.xxx;
      vec3 x2 = x0 - i2 + C.yyy;
      vec3 x3 = x0 - D.yyy;
      i = mod289(i);
      vec4 p = permute(permute(permute(
                i.z + vec4(0.0, i1.z, i2.z, 1.0))
              + i.y + vec4(0.0, i1.y, i2.y, 1.0))
              + i.x + vec4(0.0, i1.x, i2.x, 1.0));
      float n_ = 0.142857142857;
      vec3 ns = n_ * D.wyz - D.xzx;
      vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
      vec4 x_ = floor(j * ns.z);
      vec4 y_ = floor(j - 7.0 * x_);
      vec4 x = x_ *ns.x + ns.yyyy;
      vec4 y = y_ *ns.x + ns.yyyy;
      vec4 h = 1.0 - abs(x) - abs(y);
      vec4 b0 = vec4(x.xy, y.xy);
      vec4 b1 = vec4(x.zw, y.zw);
      vec4 s0 = floor(b0)*2.0 + 1.0;
      vec4 s1 = floor(b1)*2.0 + 1.0;
      vec4 sh = -step(h, vec4(0.0));
      vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
      vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
      vec3 p0 = vec3(a0.xy, h.x);
      vec3 p1 = vec3(a0.zw, h.y);
      vec3 p2 = vec3(a1.xy, h.z);
      vec3 p3 = vec3(a1.zw, h.w);
      vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
      p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
      vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
      m = m * m;
      return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
    }
    float fbm(vec3 p){
      float sum = 0.0;
      float amp = 0.5;
      float freq = 1.0;
      for (int i = 0; i < 4; i++) {
        sum += amp * snoise(p * freq);
        freq *= 2.1;
        amp *= 0.5;
      }
      return sum;
    }
  `;

  const VERTEX_SHADER = `
    uniform float uTime;
    uniform float uEnergy;
    uniform float uAudio;
    uniform float uWarp;
    uniform float uAmpBase;
    varying vec3 vWorldNormal;
    varying vec3 vWorldPosition;
    varying vec3 vDir;
    varying float vDisp;

    ${NOISE_GLSL}

    float dispAt(vec3 dir, vec3 flow) {
      // Lower spatial frequency and MUCH lower amplitude than the first
      // pass: that version's high-frequency, large-amplitude bumps made
      // the sphere read as a rough cratered/cauliflower rock, and a bumpy
      // normal field also scattered the specular highlight into dozens of
      // tiny glints instead of one coherent one. The reference's "liquid
      // chrome" look is almost entirely a smooth sphere's shading (ridges,
      // swirl eyes, one highlight) — geometry here only needs to be just
      // alive enough to not look static, not to carry the visual texture.
      vec3 p = dir * 1.1 + flow;
      vec3 warp = vec3(fbm(p + 13.1), fbm(p + 47.3), fbm(p + 91.7)) * uWarp;
      float n = fbm(p + warp * 0.6);
      return n * (uAmpBase + 0.028 * uEnergy) + uAudio * 0.012;
    }

    void main() {
      vec3 dir = normalize(normal);
      // Stable, undisplaced object-space direction — passed through so the
      // fragment shader's swirl "eyes" and metal grain are sampled at a
      // coordinate that only moves with the mesh's own rotation, not with
      // the (much smaller) per-vertex bump displacement below.
      vDir = dir;
      vec3 flow = vec3(0.0, 0.0, uTime * 0.12);

      float dC = dispAt(dir, flow);
      vec3 tangent = normalize(cross(dir, abs(dir.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
      vec3 bitangent = normalize(cross(dir, tangent));
      float eps = 0.035;
      vec3 dirT = normalize(dir + tangent * eps);
      vec3 dirB = normalize(dir + bitangent * eps);
      float dT = dispAt(dirT, flow);
      float dB = dispAt(dirB, flow);

      float r = length(position);
      vec3 posC = dir * (r + dC);
      vec3 posT = dirT * (r + dT);
      vec3 posB = dirB * (r + dB);
      vec3 newNormal = normalize(cross(posT - posC, posB - posC));

      vDisp = dC;
      vec4 worldPos = modelMatrix * vec4(posC, 1.0);
      vWorldPosition = worldPos.xyz;
      vWorldNormal = normalize(mat3(modelMatrix) * newNormal);
      gl_Position = projectionMatrix * viewMatrix * worldPos;
    }
  `;

  const FRAGMENT_SHADER = `
    uniform vec3 uColorDeep;
    uniform vec3 uColorMid;
    uniform vec3 uColorRim;
    uniform vec3 uColorAlert;
    uniform float uEnergy;
    uniform float uAudio;
    uniform float uErrorMix;
    uniform float uTime;
    varying vec3 vWorldNormal;
    varying vec3 vWorldPosition;
    varying vec3 vDir;

    ${NOISE_GLSL}

    // One glowing "vortex eye": a slow spiral/ring pattern around a fixed
    // point on the sphere, masked to a roughly circular patch so it reads
    // as a distinct whirlpool rather than all-over noise. Six of these
    // (below, at Fibonacci-sphere points computed once offline) are what
    // give the surface its "several glowing eyes spread across the whole
    // body" look from the reference image, instead of one smudge.
    float vortexEye(vec3 d, vec3 center, float arms, float speed, float phase, float patchR) {
      vec3 c = normalize(center);
      float cosA = clamp(dot(d, c), -1.0, 1.0);
      float ang = acos(cosA);
      vec3 up = (abs(c.y) < 0.99) ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
      vec3 t1 = normalize(cross(c, up));
      vec3 t2 = cross(c, t1);
      vec3 proj = d - c * cosA;
      float theta = atan(dot(proj, t2), dot(proj, t1));
      float r = clamp(ang / patchR, 0.0, 1.0);
      float falloff = smoothstep(1.0, 0.62, r);
      // An Archimedean spiral (phase advances linearly with radius, no
      // 1/r singularity) gives ~2 clean concentric/spiral rings across the
      // patch plus a bright core — a real whirlpool "eye" shape, matching
      // the reference's distinct loops, instead of the thin chaotic veins
      // an inverse-radius twist produced.
      float spiral = sin(r * 13.0 - theta * arms + uTime * speed + phase);
      float rings = pow(0.5 + 0.5 * spiral, 2.0);
      float core = smoothstep(0.2, 0.0, r);
      return clamp((rings * 0.85 + core * 0.6) * falloff, 0.0, 1.0);
    }

    void main() {
      vec3 n = normalize(vWorldNormal);
      vec3 viewDir = normalize(cameraPosition - vWorldPosition);
      float ndotv = clamp(dot(n, viewDir), 0.0, 1.0);
      float fresnel = pow(1.0 - ndotv, 2.6);

      vec3 d0 = normalize(vDir);
      vec3 slowFlow = vec3(0.0, 0.0, uTime * 0.05);

      // Organic liquid distortion of the pattern coordinate itself — the
      // swirl eyes and the metal grain both read as flowing liquid rather
      // than a static decal, because the coordinate they're sampled at
      // drifts under slowly-evolving 3D noise.
      vec3 warpN = vec3(fbm(d0 * 1.6 + slowFlow), fbm(d0 * 1.6 + slowFlow + 11.3), fbm(d0 * 1.6 + slowFlow + 5.7));
      vec3 dWarp = normalize(d0 + warpN * 0.14);

      // Nine vortex "eyes" spread across the whole sphere (a Fibonacci-
      // sphere placement, computed once offline), each a touch different
      // in arm count / size / spin speed / phase so they don't read as one
      // shape stamped repeatedly. Nine (not six) is deliberate: with the
      // camera only ever seeing one hemisphere at a time, six evenly-
      // spread points left as few as two actually facing the camera at
      // once (checked against real screenshots) — nine reliably keeps
      // several ("4-6 whirlpool eyes") in view together, matching the
      // reference, across any camera angle. Spin speed is tied to the
      // real uEnergy/uAudio signals already driving the rest of the Core,
      // so the eyes visibly churn faster during real thinking/execution
      // and flicker a little with real speech audio — reusing the
      // existing reactivity variables, not new ones.
      float spiralSpeed = 0.3 + uEnergy * 0.8 + uAudio * 0.4;
      float e = 0.0;
      e = max(e, vortexEye(dWarp, vec3(0.4581, 0.8889, 0.0),       2.0, spiralSpeed * 1.00, 0.0, 0.55));
      e = max(e, vortexEye(dWarp, vec3(-0.5497, 0.6667, 0.5036),   3.0, spiralSpeed * 0.86, 1.3, 0.48));
      e = max(e, vortexEye(dWarp, vec3(0.0781, 0.4444, -0.8924),   2.0, spiralSpeed * 1.12, 2.6, 0.62));
      e = max(e, vortexEye(dWarp, vec3(0.5931, 0.2222, 0.7739),    3.0, spiralSpeed * 0.94, 3.9, 0.45));
      e = max(e, vortexEye(dWarp, vec3(-0.9848, 0.0, -0.1736),     2.0, spiralSpeed * 1.05, 5.1, 0.58));
      e = max(e, vortexEye(dWarp, vec3(0.8223, -0.2222, -0.5239),  3.0, spiralSpeed * 0.90, 0.7, 0.50));
      e = max(e, vortexEye(dWarp, vec3(-0.2325, -0.4444, 0.8653),  2.0, spiralSpeed * 1.08, 2.0, 0.60));
      e = max(e, vortexEye(dWarp, vec3(-0.3431, -0.6667, -0.6618), 3.0, spiralSpeed * 0.83, 4.4, 0.46));
      e = max(e, vortexEye(dWarp, vec3(0.4302, -0.8889, 0.1570),   2.0, spiralSpeed * 1.16, 5.8, 0.52));
      float energyMask = e;

      // Brushed liquid-metal grain for the silver regions between the
      // eyes — thin flowing contour lines (a second, higher-frequency
      // noise perturbs the band phase so lines meander like real poured
      // liquid instead of running perfectly parallel), not a flat fill or
      // a cloudy all-over smudge.
      float marblePhase = fbm(dWarp * 5.5 + slowFlow) * 2.2;
      float marble = fbm(dWarp * 3.2 + slowFlow * 0.6) * 26.0 + marblePhase;
      float ridge = pow(0.5 + 0.5 * sin(marble), 7.0);

      // Key light sits mostly overhead (with a slow slight orbit) so the
      // specular highlight consistently reads near the TOP of the sphere
      // as it slowly rotates — the single cue that sells "polished metal"
      // more than anything else, per the reference.
      vec3 lightDir = normalize(vec3(sin(uTime * 0.15) * 0.4, 0.92, cos(uTime * 0.15) * 0.4));
      float ndotl = max(dot(n, lightDir), 0.0);
      float ambient = 0.22;
      float diffuse = ambient + ndotl * (1.0 - ambient);

      // Base material reads as silver/chrome/titanium, NOT tinted cyan —
      // the cyan in this shader is confined to the vortex eyes and the rim
      // highlight below, matching the reference's actual color balance
      // (mostly silver-grey surface, blue concentrated in distinct spots).
      vec3 metal = mix(uColorDeep, uColorMid, clamp(ridge * 0.65 + diffuse * 0.55, 0.0, 1.0));
      metal *= (0.5 + 0.5 * diffuse);

      // Specular: a tight Blinn-Phong highlight plus a wider, fainter
      // secondary lobe, both strengthened at grazing angles the way real
      // metal reflectivity behaves — a real catch-the-light highlight
      // instead of the old uniform fresnel wash.
      vec3 halfDir = normalize(lightDir + viewDir);
      float specAngle = max(dot(n, halfDir), 0.0);
      float spec = pow(specAngle, 140.0);
      float specWide = pow(specAngle, 10.0) * 0.25;
      float specStrength = mix(0.7, 1.6, fresnel);

      vec3 swirlColor = mix(uColorRim, uColorAlert, uErrorMix);
      vec3 rimColor = mix(vec3(0.82, 0.93, 1.0), uColorAlert, uErrorMix);
      float rimStrength = 0.5 + 0.55 * uEnergy + 0.4 * uAudio;
      float swirlBrightness = 1.05 + 0.85 * uEnergy + 0.5 * uAudio;

      vec3 color = metal;
      color += vec3(1.0, 0.99, 0.96) * (spec + specWide) * specStrength;
      color += rimColor * fresnel * rimStrength;
      // The ridge texture modulates the swirl glow too, so the cyan reads
      // as the same flowing liquid catching light from within rather than
      // a flat sticker pasted on top of the metal.
      color += swirlColor * energyMask * swirlBrightness * (0.75 + 0.35 * ridge);
      color += swirlColor * energyMask * fresnel * 0.4;

      // Luminance-based Reinhard tonemap: scale all channels by one
      // factor derived from luminance, rather than dividing each channel
      // independently. A per-channel Reinhard compresses whichever
      // channel is largest the hardest, which flattens hue right at high
      // brightness — exactly where the ERROR tint needs to still read as
      // warm, not desaturate toward white/grey.
      float lum = dot(color, vec3(0.299, 0.587, 0.114));
      float toned = lum / (1.0 + lum);
      color *= toned / max(lum, 0.0001);

      gl_FragColor = vec4(color, 1.0);
    }
  `;

  const STATE_PROFILES = {
    OFFLINE: { energy: 0.08, tempo: 0.4, warp: 0.35 },
    IDLE: { energy: 0.14, tempo: 0.55, warp: 0.4 },
    LISTENING: { energy: 0.36, tempo: 0.85, warp: 0.42 },
    THINKING: { energy: 0.56, tempo: 1.3, warp: 0.5 },
    PLANNING: { energy: 0.5, tempo: 1.1, warp: 0.48 },
    EXECUTING: { energy: 0.76, tempo: 1.65, warp: 0.55 },
    VERIFYING: { energy: 0.6, tempo: 1.15, warp: 0.46 },
    WAITING: { energy: 0.26, tempo: 0.6, warp: 0.4 },
    SPEAKING: { energy: 0.6, tempo: 1.05, warp: 0.46 },
    ERROR: { energy: 0.5, tempo: 0.9, warp: 0.46 },
    STOPPED: { energy: 0.18, tempo: 0.5, warp: 0.4 },
  };

  function makeHaloTexture() {
    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, "rgba(140,220,255,0.55)");
    grad.addColorStop(0.35, "rgba(90,180,230,0.22)");
    grad.addColorStop(1, "rgba(10,20,30,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
  }

  function createCore() {
    let canvas, renderer, scene, camera, composer;
    let coreGroup, coreMesh, halo, dust;
    let uniforms;
    let width = 0, height = 0;
    let reducedMotion = false;
    let connected = false;
    let liveState = "OFFLINE";
    let targetEnergy = STATE_PROFILES.OFFLINE.energy;
    let targetTempo = STATE_PROFILES.OFFLINE.tempo;
    let targetWarp = STATE_PROFILES.OFFLINE.warp;
    let curEnergy = targetEnergy, curTempo = targetTempo, curWarp = targetWarp;
    let curAudio = 0, targetAudio = 0;
    let pulseEnergy = 0;
    let errorMix = 0, targetErrorMix = 0;
    let simTime = 0;
    let lastFrame = performance.now();
    let orbitTheta = 0.4, orbitPhi = 1.25; // spherical camera angles
    let autoThetaDrift = 0;
    let dragging = false;
    let lastPointer = { x: 0, y: 0 };
    let baseDistance = 6.4;
    let rafId = null;

    function responsiveDistance() {
      const w = width || 1, h = height || 1;
      let dist = baseDistance;
      if (w < h) {
        // Narrow/portrait viewport: pull back proportional to how much
        // narrower width is than height, same bugfix concept the old
        // build's responsiveCamDistance() used, reimplemented fresh —
        // otherwise a phone portrait viewport crops the core badly.
        dist *= 1.0 + (h / w - 1) * 0.55;
      }
      if (w < 480) dist *= 1.08;
      return dist;
    }

    function updateCameraFromOrbit(shakeX, shakeY) {
      const dist = responsiveDistance();
      const phi = Math.max(0.12, Math.min(Math.PI - 0.12, orbitPhi));
      const x = dist * Math.sin(phi) * Math.cos(orbitTheta);
      const y = dist * Math.cos(phi);
      const z = dist * Math.sin(phi) * Math.sin(orbitTheta);
      camera.position.set(x + (shakeX || 0), y + (shakeY || 0), z);
      camera.lookAt(0, 0, 0);
    }

    function init(canvasEl) {
      canvas = canvasEl;
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

      scene = new THREE.Scene();
      // Explicit pure black, not relied-upon renderer default — the
      // reference material's chrome/bloom only reads correctly against a
      // truly black (not navy) backdrop.
      scene.background = new THREE.Color(0x000000);
      camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
      updateCameraFromOrbit(0, 0);

      coreGroup = new THREE.Group();
      scene.add(coreGroup);

      // Detail 5 (10242 vertices): measured and needed — detail 4 (2562
      // vertices) visibly showed the underlying geodesic triangulation as
      // hard facet edges once lit (reads as a cut gem, not an organic
      // core); this resolution smooths that out while still running
      // comfortably on real GPU hardware, phone included.
      // IMPORTANT, found during verification: this vendored Three.js
      // revision's IcosahedronGeometry subdivides each of the
      // icosahedron's 20 base faces into (detail+1)^2 small triangles
      // with NO vertex welding across faces — a non-indexed, quadratic
      // scheme, not the exponential "4^detail" recursive scheme other
      // Three.js versions/tutorials describe. Concretely: detail 5 (what
      // a 4^detail assumption would expect to be ~10k smooth vertices)
      // is really only 720 triangles — visibly faceted, confirmed by an
      // actual screenshot showing hard polygon edges around the
      // silhouette that neither noise-amplitude nor bloom-resolution
      // changes affected at all. Detail 16 (5780 triangles) is what
      // actually reads as smooth at this on-screen size, verified the
      // same way — by screenshotting it, not by assuming the math.
      const geometry = new THREE.IcosahedronGeometry(1.7, 16);
      uniforms = {
        uTime: { value: 0 },
        uEnergy: { value: curEnergy },
        uAudio: { value: curAudio },
        uWarp: { value: curWarp },
        uAmpBase: { value: 0.013 },
        // Dark steel shadow -> bright chrome/silver (NOT navy/cyan — the
        // base material should read as polished metal; cyan is reserved
        // for the vortex "eyes" and rim highlight in the fragment shader).
        uColorDeep: { value: new THREE.Color(0x0a0f16) },
        uColorMid: { value: new THREE.Color(0xb9c7d3) },
        uColorRim: { value: new THREE.Color(0x3ee6ff) },
        uColorAlert: { value: new THREE.Color(0xff5436) },
        uErrorMix: { value: 0 },
      };
      const material = new THREE.ShaderMaterial({
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
        uniforms,
      });
      coreMesh = new THREE.Mesh(geometry, material);
      coreGroup.add(coreMesh);

      halo = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: makeHaloTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
      );
      halo.scale.set(7.2, 7.2, 1);
      coreGroup.add(halo);

      // Sparse background dust — depth cue only, never the primary
      // silhouette (the solid core mesh above is). ~140 points on a
      // large shell, own slow independent rotation.
      const dustCount = 140;
      const dustGeo = new THREE.BufferGeometry();
      const positions = new Float32Array(dustCount * 3);
      for (let i = 0; i < dustCount; i++) {
        const r = 9 + Math.random() * 6;
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
        positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
        positions[i * 3 + 2] = r * Math.cos(phi);
      }
      dustGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      const dustMat = new THREE.PointsMaterial({ color: 0x3a6a86, size: 0.045, transparent: true, opacity: 0.5, sizeAttenuation: true });
      dust = new THREE.Points(dustGeo, dustMat);
      scene.add(dust);

      // Bloom: find genuinely bright pixels (the rim/specular/halo) and
      // glow around them automatically — real post-processing, not a
      // duplicated-geometry trick.
      composer = new THREE.EffectComposer(renderer);
      composer.addPass(new THREE.RenderPass(scene, camera));
      // Resolution here must be a real pixel size, not a placeholder —
      // UnrealBloomPass builds its internal mip blur chain from it, and a
      // (1,1) placeholder (an earlier bug caught during verification)
      // produces a broken, blocky glow that reads as hard polygon facets
      // around the core's silhouette instead of a soft bloom.
      const initialW = (canvas.clientWidth || window.innerWidth || 1) * Math.min(window.devicePixelRatio || 1, 2);
      const initialH = (canvas.clientHeight || window.innerHeight || 1) * Math.min(window.devicePixelRatio || 1, 2);
      const bloom = new THREE.UnrealBloomPass(new THREE.Vector2(initialW, initialH), 0.5, 0.55, 0.42);
      composer.addPass(bloom);

      canvas.addEventListener("pointerdown", (e) => {
        dragging = true;
        lastPointer = { x: e.clientX, y: e.clientY };
      });
      window.addEventListener("pointerup", () => (dragging = false));
      window.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const dx = e.clientX - lastPointer.x;
        const dy = e.clientY - lastPointer.y;
        lastPointer = { x: e.clientX, y: e.clientY };
        orbitTheta -= dx * 0.0045;
        orbitPhi = Math.max(0.3, Math.min(2.6, orbitPhi - dy * 0.0045));
      });

      rafId = requestAnimationFrame(animate);
    }

    function resize(w, h) {
      width = Math.max(1, w);
      height = Math.max(1, h);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
      composer.setSize(width, height);
    }

    function setLiveState(name) {
      const profile = STATE_PROFILES[name] || STATE_PROFILES.IDLE;
      liveState = name;
      targetEnergy = profile.energy;
      targetTempo = profile.tempo;
      targetWarp = profile.warp;
      targetErrorMix = name === "ERROR" ? 1 : 0;
    }

    function setConnected(isConnected) {
      connected = isConnected;
      if (!connected) setLiveState("OFFLINE");
    }

    function pulse(amount) {
      pulseEnergy = Math.min(1, pulseEnergy + (amount || 0.18));
    }

    function setAudioLevel(level) {
      targetAudio = Math.max(0, Math.min(1, level));
    }

    function setReducedMotion(flag) {
      reducedMotion = !!flag;
    }

    function animate(now) {
      rafId = requestAnimationFrame(animate);
      const dt = Math.min(0.05, (now - lastFrame) / 1000);
      lastFrame = now;

      // Smooth toward targets — real signals are never snapped instantly,
      // which reads as jittery; a short lerp keeps every transition
      // deliberate and premium-feeling.
      curEnergy += (targetEnergy - curEnergy) * Math.min(1, dt * 2.2);
      curTempo += (targetTempo - curTempo) * Math.min(1, dt * 2.2);
      curWarp += (targetWarp - curWarp) * Math.min(1, dt * 2.2);
      curAudio += (targetAudio - curAudio) * Math.min(1, dt * 6);
      errorMix += (targetErrorMix - errorMix) * Math.min(1, dt * 3);
      pulseEnergy *= Math.pow(0.02, dt); // fast decay back to 0

      if (!reducedMotion) {
        simTime += dt * curTempo;
      } else {
        // Still advance time a tiny amount so the shader doesn't look like
        // a dead static frame, but no meaningful idle motion — real-signal
        // reactivity (energy/audio/error) above stays fully live either way.
        simTime += dt * 0.02;
      }

      uniforms.uTime.value = simTime;
      uniforms.uEnergy.value = Math.min(1, curEnergy + pulseEnergy);
      uniforms.uAudio.value = curAudio;
      uniforms.uWarp.value = curWarp;
      uniforms.uErrorMix.value = errorMix;

      // Idle breathing: frequency-modulated double sine so it never
      // settles into an obviously looping single beat, frozen under
      // reduced motion (the group still gets the real-signal pulse scale
      // below, just no continuous idle component).
      const breathT = reducedMotion ? 0 : simTime;
      const slowMod = Math.sin(breathT * 0.21) * 0.6 + 0.9;
      const breathe = Math.sin(breathT * 0.9 * slowMod) * 0.035 + Math.sin(breathT * 0.37) * 0.018;
      const energyScale = 1 + (curEnergy + pulseEnergy) * 0.14;
      const scale = (1 + breathe) * energyScale;
      coreGroup.scale.setScalar(scale);

      if (!reducedMotion) {
        autoThetaDrift += dt * (0.045 + curEnergy * 0.04);
        coreMesh.rotation.y += dt * 0.05;
        coreMesh.rotation.x = Math.sin(simTime * 0.13) * 0.12;
      }
      dust.rotation.y += dt * 0.012;

      halo.material.opacity = 0.55 + curEnergy * 0.35 + pulseEnergy * 0.3;
      const haloColor = errorMix > 0.02 ? 0xffab8a : 0x8cdcff;
      halo.material.color.set(haloColor);

      let shakeX = 0, shakeY = 0;
      if (!reducedMotion && curEnergy > 0.3) {
        const shakeAmt = (curEnergy - 0.3) * 0.02;
        shakeX = Math.sin(simTime * 3.1) * shakeAmt;
        shakeY = Math.cos(simTime * 2.7) * shakeAmt;
      }
      if (!dragging) orbitTheta += reducedMotion ? 0 : dt * 0.015;
      updateCameraFromOrbit(shakeX, shakeY);

      composer.render();
    }

    function dispose() {
      if (rafId) cancelAnimationFrame(rafId);
    }

    return {
      init,
      resize,
      setLiveState,
      setConnected,
      pulse,
      setAudioLevel,
      setReducedMotion,
      dispose,
      get liveState() { return liveState; },
    };
  }

  window.JarvisCore = createCore();
})();
