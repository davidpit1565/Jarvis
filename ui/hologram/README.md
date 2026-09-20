# JARVIS hologram visualizer

A standalone holographic AI-core HUD, in the style of a sci-fi AI interface:
an abstract, activity-reactive energy core rendered as glowing wireframe
spheres in Three.js, side telemetry panels, a glowing base plinth labeled
JARVIS, and an occasional glitch/warning-banner effect.

## Running it

No build step — it's a self-contained page. Just open it directly:

```
open ui/hologram/index.html
```

(or double-click it in Finder). `three.min.js` is vendored locally in this
folder on purpose, not loaded from a CDN, so the visualizer works offline —
appropriate for a local personal-assistant UI that shouldn't depend on
internet access just to render itself. The whole Core (see below) is
procedural geometry built at page load — no external model file, so there's
nothing to fetch and no `file://` restrictions to work around for it.

**Face tracking (👁 ENABLE FACE TRACKING) is the one thing that needs a
local server, not `file://`.** Chromium blocks `fetch()` for local files
under the `file://` origin, which is what loads the face-tracking model
weights (unlike `<script src>` tags, which are exempt — how everything else
on this page, including the Core, avoids that problem entirely). Run any
static server from this folder and open it over `http://` instead:

```
python3 -m http.server 8080   # from ui/hologram/
# then open http://localhost:8080/
```

Clicking the button while on `file://` shows an explicit
`NEEDS LOCAL SERVER` message instead of a silent/confusing failure.

## The Core — why an abstract shape, not a face

This page used to render a real human 3D face scan
([LeePerrySmith](https://github.com/mrdoob/three.js/tree/master/examples/models/gltf/LeePerrySmith),
from Three.js's own official examples) as a wireframe head, chasing a
cinematic AI-generated reference video's look. That went through a long
series of rounds — density and brightness, a real latitude/longitude grid
computed on the mesh surface (replacing `THREE.EdgesGeometry`, which
tangled on this mesh's own irregular triangulation), cropping the scan's
real wide shoulders, a measured crown-vs-face proportion fix, a soft
per-vertex alpha fade for the eye/mouth/nostril cavities instead of a hard
cut — and kept closing individual gaps without closing the overall one.
Direct feedback stayed consistent throughout: *"this looks like a fake of
the original."*

The actual reason: a **real face scan** carries real anatomical specifics —
one specific person's exact asymmetry, separately-sculpted eyeball spheres,
a literal open mouth with teeth (all standard for a face-scan/rig asset,
none of it optional) — that a **synthetic cinematic reference render**
never has to reconcile in the first place. No amount of grid-tuning closes
a gap that's actually about what *kind* of object the two things being
compared are.

Before rebuilding, this looked at what real, shipped voice-AI interfaces
actually use — not another guess at what "looks futuristic": ChatGPT's
Advanced Voice Mode (a glowing animated sphere, not a face), documented
voice-orb design systems that converge on the same idle/listening/
thinking/speaking state model across independent implementations, and
open-source Iron-Man-style "Arc Reactor" builds that hook the Web Audio
API directly to TTS output to drive a procedural core's pulse and spin.
**None of them use a real human face.** An abstract, audio/activity-reactive
core is the actual industry norm for this kind of interface, not a
compromise reached after a real face didn't work out.

### What it's built from

- **Outer shell — a real curl-noise flow field**, not a wireframe (see the
  dedicated section below for why and how). ~1,200 particles seeded at an
  irregular radius around a rough sphere, swirling together in coherent
  tendrils.
- **Inner shell** — a smaller concentric wireframe sphere (amber), the
  "mind," which brightens, grows, and spins faster while Jarvis is
  actively thinking.
- **The particle "mind"** — a dense amber point cloud with connecting
  "synapse" lines inside the inner shell, carried over unchanged from the
  old build's brain: continuous per-particle drift, periodic synapse
  re-wiring, and a brightness/size pulse tied to real activity (below).
  Never fully static, even at rest.
- **Two crossing orbit rings**, continuously and independently rotating —
  this page's own identity now, not echoing one shot of a reference video.
- **A soft outward bloom halo** (a large sprite with a custom
  gradual-falloff gradient texture, not the small accent-dot texture used
  elsewhere — that one shows a visible hard edge at this scale).

Being fully abstract and radially symmetric-ish by construction, the Core
has **no "wrong from the back" problem** the way the old head did — there's
no anatomy to get right or wrong from any angle, so orbiting around it (see
below) just works everywhere, with no per-angle tuning.

### The outer shell is a curl-noise flow field, not a wireframe sphere

The Core's first version rendered its outer shell as a `THREE.SphereGeometry`
wireframe — a clean lat/long grid. Direct feedback, backed by reference
images (Iron Man's JARVIS brain-formation VFX, and other AI-hologram
concept art), was that this reads as **a globe, not a living AI core** — a
UV-sphere wireframe has visible latitude/longitude lines because that's
literally what it is, and a perfectly uniform radius is what makes a point
cloud read as a planet in the first place.

The actual, named technique behind the reference images' organic, swirling,
"brain with waves" look is **curl noise** — the *curl* of a noise field
(divergence-free by construction), not the noise field itself. This is a
well-documented real-time VFX technique (see Three.js Journey's "GPGPU Flow
Field Particles" lesson and al-ro's "3D Curl Noise" writeup) for exactly
this look: particles pushed by a curl-noise field swirl and tumble together
in coherent tendrils, never converging to a point and never flying apart,
because the field has zero divergence by construction. That's categorically
different from either a smooth geometric wireframe (mechanically regular)
or independent per-particle sine jitter (visibly synchronized/mechanical
once you watch it a few seconds, since every particle runs its own
disconnected clock) — with curl noise, *nearby* particles share almost the
same field sample, so they move together, and distant particles diverge,
which is what makes it look like flowing energy instead of a bag of
independently-vibrating dots.

Implementation (`curlNoise3()`/`simplex3()` in `index.html`, right after
`addSizePulse()`): a compact public-domain 3D simplex noise (same
Gustavson/Ashima algorithm family as the GLSL version already used for the
energy surface's shader), then curl computed via the textbook formula —
three offset noise samples build a vector potential Ψ = (p, q, r), and
curl(Ψ) = (∂r/∂y − ∂q/∂z, ∂p/∂z − ∂r/∂x, ∂q/∂x − ∂p/∂y), each partial
derivative a central difference. This runs on the CPU, once per particle
per frame (`buildFlowShell()`'s particles, advected in `animate()`) rather
than a GPGPU render-to-texture pipeline, since this vendored Three.js r128
setup has no build step to add one — measured with a real fake-vs-real A/B
FPS comparison (headless, `performance.now()` over 3s) against the previous
wireframe build: no regression (15.1fps vs. 12.0fps under this sandbox's
software `swiftshader` renderer — both numbers are low only because there's
no real GPU here at all; a real GPU renders either version far faster).

Each particle also gets pulled gently back toward its own anchor point
every frame (a soft "leash," proportional to how far it's drifted) so the
flow visibly swirls *around* the Core's envelope instead of drifting away
or collapsing inward — the standard way to keep a curl-noise field
bounded to a shape rather than letting it disperse. Turbulence amplitude
is never zero (per direct request, the Core must never sit still like a
flat static image) and grows further with real thinking/voice activity,
same as every other signal on this page. Frozen (no per-frame advection)
under `prefers-reduced-motion`, same rule as every other continuous motion
source here — the real-signal-driven group scale/opacity changes stay on.

### Real bloom (`UnrealBloomPass`), not a duplicated-shell trick

Every glow on this page used to be faked the same way: redraw the same
line geometry a second time, bigger and fainter, underneath the crisp
copy — a real technique (used throughout production motion graphics when
real bloom isn't available), but a manual one, applied per-object, that
only ever glows around literal duplicated geometry.

This page now runs a real post-processing bloom pass —
`THREE.EffectComposer` + `THREE.RenderPass` + `THREE.UnrealBloomPass`,
the official Three.js r128 example scripts (matching the vendored
`three.min.js` exactly, fetched from the same public npm release,
MIT-licensed same as Three.js itself — not hand-written, not a CDN
dependency, vendored locally under `postprocessing/`/`shaders/` the same
way `facetrack/` already is). Real bloom finds genuinely bright pixels
*anywhere in the rendered frame* — the energy surface's fresnel rim, the
flow field's particles, the brain's points — and glows around them
automatically, with zero extra per-object setup, which is exactly why it
reads as more "alive"/premium than the old per-shell trick could.

`strength`/`radius`/`threshold` (0.42 / 0.4 / 0.35) were tuned against
real screenshots, not guessed: an initial 0.75 strength blew out the
center to near-solid white and lost the wireframe's crisp line detail —
turned down until the glow reads as energy radiating off real geometry,
not overexposure. The CORE ACTIVITY panel's background also had to be
darkened slightly (0.35 → 0.55 alpha at the bottom edge) — real bloom is
bright enough to bleed through what used to be a subtle enough gradient,
and the newest (bottom-most, most important) activity lines were the
first to lose legibility.

**Real, measured performance cost, not hidden**: a real FPS A/B on this
sandbox's software `swiftshader` renderer (headless, `performance.now()`
over 3s, no real GPU available here at all) showed bloom taking this
page from ~15fps to ~6fps. That is a genuine cost of multi-pass
post-processing, not a rounding error — but it's specifically a
*software*-rendering cost: `UnrealBloomPass` is a standard, GPU-optimized
real-time technique (mip-mapped blur passes on the GPU) used at native
60fps+ in production games and demos on any real graphics hardware, which
this sandbox has none of. Worth knowing about, not worth avoiding real
bloom over — but real hardware verification (does this still feel smooth
on the actual machine this runs on) is the one honest gap this
environment structurally cannot close, same category as the Swift Agent
tools' "requires real macOS validation."

### Individually pulsing dots — not a field of fixed-size points

Every glowing dot on the outer shell (and the brain's particles) individually
grows and shrinks over time on its own random phase, rather than a fixed
size or the whole field pulsing in lockstep — the "always alive" look real
production voice-AI HUDs have. `addSizePulse()` in `index.html` implements
this by patching the one `gl_PointSize = size;` line in Three.js's own
built-in points vertex shader (present verbatim across versions, including
this vendored r128) via `material.onBeforeCompile`, multiplying it by a
per-vertex sine term driven by a `uTime` uniform and a random `aPhase`
attribute — chosen over writing a full custom `ShaderMaterial` from scratch
so Three's existing perspective size-attenuation math keeps working for
free. Frozen (not ticking `uTime`) under `prefers-reduced-motion`.

### The inner "mind" shell was still a literal globe grid — fixed

The outer flow-field shell was rebuilt to escape "reads as a globe" (see
above), but the inner "mind" shell directly underneath it — the shape
you actually stare at in the center of the Core — was left over as a
plain `THREE.SphereGeometry(1.0, 18, 14)` wireframe: a real
latitude/longitude grid, the exact same problem, just smaller and dead
center. That's a real contributor to "still looks like Earth" surviving
the outer-shell rebuild. Fixed with `buildOrganicWire()` in `index.html`:
an `IcosahedronGeometry` (detail 3) with every vertex pushed outward
along its own radial direction by a `simplex3()` sample at that
direction (the same noise function the outer shell/energy surface
already use — not a second implementation) before building the
wireframe from it. The result is a genuinely irregular, folded mesh —
no two "latitude lines," no visible poles — closer to a real convoluted
brain surface than a sphere.

### Free multi-axis idle tumble, not a Y-axis sway

Idle rotation used to be `sin(t)` sway on all three axes, but X and Z's
amplitude (0.07 / 0.025 rad, a few degrees) was small enough to be
functionally invisible — in practice the Core only ever visibly rotated
around Y, which is exactly what makes something read as "a globe/planet
spinning on its axis" rather than a free-floating organism. Per direct
request (rotation should be free in every direction, including up/down,
the way something alive tumbles, not a fixed spin), X and Z now swing as
widely as Y, and Y additionally carries a slow unbounded drift term on
top of its wobble so the Core keeps turning through new facings forever
instead of settling into a bounded left-right sway. Four non-harmonic
frequencies/phases across the three axes keep them from ever
resynchronizing into an obviously looping cycle.

### Real thinking now grows the outer body too, not just the inner mind

`brainPulse` already grew/brightened the inner mind shell on real
`brain.request`/`brain.response` activity; the outer flow-field
body/energy surface only ever responded to voice (`audioGlow`), so a
real "thought" with no accompanying audio never visibly grew the Core's
outer envelope — only its center. The outer body's scale now also takes
a (smaller-weight) contribution from `brainPulse`, so a real thinking
burst swells the whole Core, not just the mind inside it, while voice
still reads as the bigger, faster pulse.

### A third, fine noise octave on the body's silhouette

`blobRadius()`'s two lobes (a big base shape, plus secondary bumps) still
read as a smooth-ish amoeba/cell outline from a normal viewing distance,
even while genuinely swirling — direct feedback was still "smooth blob,"
not "brain." A third, low-amplitude, higher-frequency octave (`lobe3`,
weight 0.09 vs. 0.85/0.25 for the other two — a fine ripple, not another
visible lobe) adds cortex-fold-like surface detail on top of the main
silhouette without changing its overall shape language.

## Ten more VFX passes — depth, energy flow, and discrete event feedback

A further round on the same "make it read as a living AI core, not a
globe/planet" direction, all scoped to the Core's own materials/shaders/
motion in `index.html`:

1. **Depth-fog tint on the outer flow-field particles.** Every particle
   used to render at one flat, uniform color regardless of where it sat
   relative to the camera — a real depth cue a point cloud otherwise has
   no way to give, and part of why the swirling shell could still read
   as "a flat disc" despite genuinely being 3D. Each particle's fixed
   direction (already stored for `blobRadius()`) is now dotted every
   frame against the camera's direction in the Core's own rotated local
   space (one vector transform per frame, then a dot product per
   particle — not a full per-particle world transform): particles facing
   the camera render at full brightness, particles on the far side dim
   toward ~45%, the same "backface dimming" real-time point-cloud
   renderers use for cheap depth without per-pixel lighting.
2. **Traveling energy-pulse orbit rings.** The two crossing rings were a
   flat `MeshBasicMaterial` — one uniform color and brightness all the
   way around, which combined with the crossing-ellipse layout is
   exactly what a set of Saturn/planetary rings looks like. `buildEnergyRing()`
   gives each ring a small `ShaderMaterial` that computes each fragment's
   angle around the ring and brightens a few lobes that sweep around it
   over time, so the rings themselves visibly carry moving energy — an
   actual arc-reactor/energy-conduit look — instead of just spinning as a
   rigid painted band.
3. **Neural/tendril "firing" flash-and-decay.** Every synapse line in the
   brain, and every tendril thread on the outer shell, used to sit at one
   constant opacity regardless of whether it was a brand-new connection
   or an old one about to be replaced. Both now carry a per-line
   brightness that jumps to full on the frame it's (re)picked and decays
   back to a dim idle floor — a real action-potential-style flash instead
   of a permanently-lit wire — using per-vertex color attributes (`vertexColors`)
   so a single `LineSegments` draw call can still show every line at its
   own independent brightness.
4. **Real-event shockwave bursts.** A real `brain.request`/`brain.response`
   only ever showed up as the existing `brainPulse` brightening/growing
   the Core in place — legible if you're staring at the center, easy to
   miss otherwise. `spawnShockwave()` (called from `pushActivityLine()`
   on every such event, real or labeled-demo) now also fires a billboarded
   expanding-and-fading ring from a small pool of five, the same
   "something just happened" language real HUD/sonar/radar interfaces use
   for a discrete event — layered on top of the continuous growth, not
   replacing it.
5. **State-tied halo color.** `coreHalo`, the big soft bloom-halo sprite,
   was a fixed cyan regardless of what the Core was doing. It now blends
   toward amber with real thinking activity (the same color mix the
   energy surface's shader already does) and brightens with either real
   signal, so the ambient glow itself reads "thinking" at a glance instead
   of only the small inner mind shell and the text state label doing that
   job.
6. **A moving specular "energy glint" on the energy surface.** The
   fresnel rim lit every silhouette edge equally, which reads as a
   matte/diffuse surface — a real glassy or metallic energy field catches
   a highlight that travels across it as it turns. Added a slow-orbiting
   light direction dotted against the surface normal in the fragment
   shader for a real specular highlight that sweeps the surface over
   time, brightened further by real audio/thinking activity.
7. **Camera micro-shake tied to real activity.** A perfectly static
   camera is part of what makes a render read as a diagram rather than
   something being observed live — real sensor/HUD footage always
   carries a little handheld noise. The camera now gets a small
   simplex-noise-driven offset scaled by `brainPulse`/`audioGlow`,
   recomputed from the exact orbit position fresh every frame (rather
   than accumulated onto the previous frame's position) so it can never
   drift the camera away from the angle the user actually left it at.
8. **A real 3D depth-dust layer.** The only depth cue in the scene before
   this was the 2D "matrix rain" canvas *behind* the WebGL scene — a flat
   backdrop, nothing actually in 3D space around the Core to parallax
   against as the camera orbits. `buildDepthDust()` scatters 260 small,
   dim points through a spherical shell around the whole scene, with its
   own slow independent rotation distinct from the Core's, so the volume
   around the Core visibly parallaxes instead of the Core sitting alone
   on an empty stage.
9. **A third, independent wobble axis on the orbit rings.** The rings'
   only "extra" motion beyond inheriting the Core's own tumble was a
   single wobble axis — combined with the crossing-ellipse layout, still
   read as a fixed set of planetary rings from most angles. A third,
   out-of-phase wobble breaks that up further.
10. **A frequency-modulated "heartbeat" instead of a single clean sine.**
    The idle breathing scale was one unchanging sine wave — a real
    biological rhythm is never a perfect single frequency. A second,
    faster term whose own phase is itself slowly modulated by a much
    slower sine (frequency modulation, not just a second fixed sine added
    on top) keeps the combined rhythm from ever landing on an obviously
    repeating beat within a normal length of observation.

**Verified**: headless Playwright/Chromium against a local static
server — zero page errors across idle load, a full DEMO-feed
brain.request/brain.response cycle (confirming the shockwave burst, the
halo's amber shift, and the ring/tendril firing flashes all actually
fire), `prefers-reduced-motion` (frozen, no artifacts), and camera-orbit
drag to the vertical extreme (confirming the added per-frame
`updateCameraFromOrbit()` call plus shake doesn't fight manual dragging).
**Real, measured cost**: a real FPS A/B on this sandbox's software
`swiftshader` renderer (headless, `requestAnimationFrame`-counted over
3s, same "no real GPU here at all" caveat as the bloom-pass measurement
above) showed 8.7fps before this round vs. 8.4fps after — a small,
honestly-measured cost, not a rounding error hidden.

### Reactivity — three real signals, no fake state

- **Thinking** (`brainPulse`/`brainIntensity` in `index.html`) — real
  `brain.request`/`brain.response` activity from the observer feed (or the
  labeled demo feed when Core is offline) brightens and grows the inner
  shell + particle brain, then decays back to a gentle idle baseline.
  `brainIntensity` tracks *how big* the real thought was (`messageCount`
  for a request, `toolCallCount` for a response) so a longer real
  conversation or more tool calls grows the Core more than a trivial one —
  not just for a longer fixed duration.
- **Speaking / voice-reactive** (`audioGlow`) — the real Web Audio
  `AnalyserNode` level brightens, grows, and speeds up the rotation of the
  outer shell and orbit rings. Fed by the 🎙 mic button today (see "Voice
  reactivity" below); ready for real Core TTS output later with no code
  changes, via the same `window.JarvisHologram` hooks the old build used.
- **Attention** (webcam face tracking, unchanged from the old build) — the
  whole Core turns toward a real tracked face instead of its idle sway.

**Deliberately not implemented**: a "listening" state (the orb visibly
contracting as the user's own voice rises, per the documented voice-orb
pattern). That needs real speech/wake-word detection distinguishing "the
user is talking to Jarvis" from generic audio input, which doesn't exist
in Core yet — faking it here would mean inventing a signal, which this
page has consistently avoided everywhere else (see the `DEMO`/`LIVE`
labeling on the activity feed and dashboard panels below). Add it once
Core has a real signal to drive it.

## Viewing it from any angle — drag to orbit

Click-and-drag anywhere on the page to rotate the camera freely around the
Core (mouse wheel to zoom); it's real 3D geometry, not a flat sprite. This
is separate from webcam face tracking: **orbiting moves the camera** around
a Core that stays put; **face tracking rotates the Core itself** to face
wherever your tracked face is. Both can be in play at once.

Vertical drag range was ±1.2 rad (~69°) — enough to tilt the view, not
enough to actually look from above or below. Per direct request (it's
round, so dragging should work in every direction, not just side to side),
this is now ±1.55 rad (~88.8°) — close enough to straight overhead/
underneath to feel unrestricted, stopping just short of the exact pole
where the camera's up-vector would flip (a real gimbal-lock artifact, not
a style choice). Verified with real screenshots dragged to both extremes.

## Background depth

The background is no longer a flat gradient alone: a cheap 2D-canvas
"matrix rain" of falling characters runs behind the WebGL scene (frozen to
a static frame under `prefers-reduced-motion` instead of animating
forever), plus a handful of blurred vertical light strips and blinking LED
dots standing in for distant server racks — pure CSS, no extra geometry.

## Live "CORE ACTIVITY" feed — real, not simulated, once Core is running

The bottom panel connects to a real, read-only endpoint on Core:
**`/observer`** (added in `JarvisWebSocketServer.ts`). Any socket that
connects there is added to a spectator set and gets every real EventBus
event mirrored to it verbatim — `brain.request`/`brain.response`,
`tool.requested`/`tool.executed`/`tool.dispatched`, `permission.checked`,
`device.registered`/`connected`/`disconnected` — as
`{"type", "payload", "timestamp"}` JSON. No device-registration handshake
is required or accepted from it; it can't send commands, only receive.

Run Core (`bun run start`, default port from `JARVIS_PORT`, `4770`), open
this page, and the panel switches from `DEMO · CORE OFFLINE` to
`LIVE · CONNECTED TO CORE` automatically — it retries the connection every
5 seconds if Core isn't up yet or drops. Point it at a different host/port
with `?host=...&port=...` in the URL.

**When Core is offline** (which is the common case right now), the panel
honestly falls back to a clearly-labeled `DEMO` feed of representative
events, so it's never ambiguous whether what's on screen is real.

**A real console now, not a one-line summary.** Per direct request —
*"whatever I ask it to do, I want to see, through Jarvis, how it does
it"* — `tool.requested`/`tool.executed` used to show `toolName(...40
chars...)` and `ok=true`; they now show the real arguments and the real
result data (up to 280 characters, with a `…` marker rather than a silent
cut-off), and `permission.checked` shows the real reason a check passed
or failed. The panel itself changed from a fixed 7-line, non-scrolling
window (older lines just vanished) to a real scrollback — up to 60 lines,
scrollable, auto-following the newest line unless you've manually scrolled
up to read history (the same behavior any real terminal/console uses).
Fixed the same pass found: the panel's `innerHTML` was never escaping
event text before insertion — a latent XSS gap, since a URL, email body,
or file path from a real tool call could contain `<`/`>`. Verified with a
real fake-Core message containing a literal `<script>` tag in a URL: it
renders as visible text (`&lt;script&gt;`), confirmed zero `<script>`
elements were actually created in the DOM.

The same real connection check now also drives the headline text under the
`JARVIS` wordmark itself. It used to read a hardcoded, unconditional
"CORE ONLINE" regardless of whether anything was actually connected — the
single most prominent piece of fabricated state on the page, sitting right
under the title. It now reads `CORE ONLINE` / `CORE OFFLINE` from the exact
same `isLive` flag the CORE ACTIVITY panel uses, colored the same
green/amber as every other LIVE/DEMO badge.

Directly beneath it, a small **state label** (`IDLE` / `THINKING` /
`VOICE ACTIVE`) surfaces the same two real signals that already drive the
Core's shape — `brainPulse` (real, or labeled-demo, brain activity) and
`audioGlow` (real mic/voice level) — as text, so at a glance you can tell
*why* the Core is moving the way it is. Deliberately no `LISTENING` state:
that's the standard fourth state in the idle/listening/thinking/speaking
pattern most voice-AI UIs converge on, but Core has no real speech-detection
signal to back it with, so — same rule as everywhere else on this page —
it's left out rather than faked.

## Real, persistent growth — not just a momentary pulse

Per direct request: *"based on how it answers me, how it thinks... it
should also grow."* `brainPulse`/`brainIntensity` above already make the
Core grow and brighten for the few seconds around a real thought, then
decay back down — that's reactivity, not growth. This is the other half:
a real, **persistent** baseline size, `growthScale`, that only ever
increases from genuine accumulated use.

Every real `brain.request`/`brain.response` Core sends this page (never
the labeled DEMO feed — a 4th parameter on `pushActivityLine()`,
`isReal`, is only ever `true` from an actual `/observer` WebSocket
message, and demo-feed calls simply never pass it) increments a counter
persisted to `localStorage`. The Core's idle size is `growthScale` times
its base size, on a real diminishing-returns curve (`log10`) capped at
+22% total — chosen small enough that even fully "grown" the Core stays
well inside the panel clearance margins measured for both desktop and the
narrow-viewport fit above, so growth can never crowd anything out or
reintroduce the overlap bugs already fixed. It survives page reloads
(same origin) since it's read from `localStorage` on load, not reset to a
fixed starting value.

Shown honestly, not left invisible: a **GROWTH** row in the SYSTEM STATUS
panel (`×1.00` at zero real events, climbing toward `×1.22`) — the same
principle as the STATE label above: if the Core's own baseline size is
changing, the dashboard says why instead of leaving it a silent mystery.
`localStorage` access is wrapped in `try/catch` throughout (private
browsing, blocked storage, or `file://` edge cases all fail differently
across browsers) so a storage failure never breaks the page — growth
simply won't persist that session.

Verified with a real fake Core WebSocket server (a tiny `Bun.serve`
script, not a mock of the growth code itself) sending a genuine burst of
`brain.request`/`brain.response` frames: the GROWTH row climbed in step
with the real event count, `localStorage`'s stored count matched exactly,
and — the actual point of the feature — reloading the page carried the
accumulated count forward instead of resetting it. A second run confirmed
the inverse just as concretely: with Core genuinely offline (demo feed
only, several full 2.2s demo cycles), the counter never left `null` —
proof the demo feed cannot, not just does not, touch it.

## Real dashboard numbers, not decoration — TOOL REGISTRY / DEVICES / OBSERVERS

The two side panels also poll a second real endpoint, **`GET /status`**
(also on `JarvisWebSocketServer.ts`), every second — real device counts,
the real registered tool list, and how many observer sockets are
connected. Each panel's heading shows `LIVE` or `NO DATA` for this
specifically (independent of the activity feed's own status), and the
three real rows show `—` rather than a fabricated-looking number while
unreachable. `NEURAL SYNC` / `MEMORY LOAD` / `LATENCY` / `PROTOCOL` stay
honestly cosmetic — Core exposes no CPU/process telemetry, so there's
nothing real for them to show yet.

`/status` sends `Access-Control-Allow-Origin: *` on purpose: this page is
typically opened as a `file://` document, and without that header the
browser silently blocks it from reading the response even though the
request reaches Core fine. Covered by `tests/integration/statusHttp.test.ts`.

Covered by `tests/integration/observerBroadcast.test.ts`.

Every panel sits on a flat, solid `rgba(3,12,16,0.5)` backing plate rather
than floating bare over the scene — the Core's outer ring is large enough
that at some viewport widths it passes directly behind a panel's heading,
and bare text there got its first letter visually clipped by the ring
underneath it. A solid plate keeps every panel legible regardless of what
the Core is doing behind it. Deliberately not `backdrop-filter`: blurring
a handful of overlapping translucent layers at once is a known Chrome
renderer crash risk on some GPUs, so a plain flat fill is used instead —
same visual job, zero risk, no blur cost.

## Voice reactivity — two independent real meters, YOU and JARVIS

The Core visibly brightens, grows, and spins faster in response to live
audio via the Web Audio API (`AnalyserNode`) — genuine frequency-domain
analysis, not a fake animation loop.

Per direct request — *"for each of us, me and Jarvis, a row like this
with our voice so we can see the pitch/tone"* — there are now **two fully
independent analyser graphs**, not one shared one: a **YOU** meter (cyan,
fed by the mic) and a separate **JARVIS** meter (amber, fed by Jarvis's
own TTS output once Core has one). Two people talking at once — or one
talking while the other is silent — read correctly on their own meter;
neither can light up the other's. `window.JarvisHologram` exposes:

- `connectAudioElement(mediaEl)` — feed it an `<audio>`/`<video>` element
  playing Jarvis's speech, into the **JARVIS** meter.
- `connectJarvisMediaStream(stream)` — feed it a raw `MediaStream` (e.g. a
  WebRTC or streaming-TTS pipeline), also into the **JARVIS** meter.
- `connectMediaStream(stream)` — feed it a raw `MediaStream` into the
  **YOU** meter (what the 🎙 mic button below uses).

**Core has no TTS/voice output at all yet**, so there's nothing genuine to
auto-connect to the JARVIS meter today — it stays honestly idle/flat until
something real feeds it. The "🎙 CONNECT MIC" button is a real, working way
to see the YOU meter live right now — it feeds your actual microphone in,
honest proof the mechanism works rather than a placeholder pretending to
be voice output. The Core's own body reactivity (`audioGlow`) responds to
*whichever* of the two is louder at any moment, so the existing mic-based
demo keeps working exactly as before, and Jarvis's own voice will drive
the Core too the instant real TTS is connected — zero further code changes
needed there.

A scrolling bar meter (`#voice-bars`, above the plinth) in the style of a
WhatsApp voice-message waveform draws from the YOU analyser in real time —
a flat near-zero line whenever nothing is connected, never a fabricated
idle waveform, lighting up green the moment the mic is connected.

The **VOICE panel** on the right side of the screen (below CORE STATUS)
now shows both meters stacked, each with its own 24-bar frequency spectrum
and its own `IDLE`/`LIVE` badge — `youMeter`/`jarvisMeter` in `index.html`,
built from one shared `makeSpectrumMeter()` factory (parameterized by
canvas id and color) rather than two hand-duplicated copies of the drawing
code, so the two can never silently drift apart in behavior. Each reads
its own per-frame `AnalyserNode.getByteFrequencyData()` array directly and
draws each frequency bin as its own bar — so you can actually see how a
voice's frequency content is shaped (bass-heavy vs. bright, a hard
consonant vs. a sustained vowel, pitch and tone), not just how loud it is.
Only the lower ~60% of the FFT's bins are drawn, since that's where speech
energy concentrates and the upper bins would otherwise sit flat. Every bar
renders at a small non-zero floor height even at zero signal (so the panel
always reads as "a spectrum," not "a broken canvas") and brightens to a
fully lit color — cyan-to-amber for YOU, amber-to-pale-amber for JARVIS —
the moment real audio is flowing on that specific meter. Verified with a
real oscillator run through a `MediaStreamDestination` fed into
`connectJarvisMediaStream()` alongside a real mic connection: both meters
went `LIVE` independently, at the same time, with visibly different
frequency content.

## Webcam face tracking — the Core turns to face you, for real

Click **👁 ENABLE FACE TRACKING** (needs a local server — see "Running it"
above) and grant camera access. This runs real face detection —
[face-api.js](https://github.com/vladmandic/face-api) with the tiny-face
detector + 68-point landmark model, vendored locally under
`facetrack/` (~1.6MB total, no CDN) — not a scripted "always looks at
center" loop. While a face has been seen in the last 1.5 seconds, the
Core's rotation is driven by the tracked face's position in frame (turning
toward wherever you are, mirror-style) and smoothly falls back to its idle
sway the moment you step out of frame. Detection runs roughly every 120ms
in a plain polling loop, independent of the render loop, so a slow
detection frame never stalls the animation.

**Honest limits**: this is 2D face-box tracking (yaw/pitch approximated
from where the detected face sits in the frame), not full 3D head-pose
estimation. It also could not be verified against a real human face in
this sandboxed dev environment (no physical camera; Playwright's
fake-camera device produces a synthetic test pattern, not a face), so
what's verified here is that model loading, camera permission, and the
graceful "no face seen" fallback all work correctly against a real running
pipeline — the actual tracking quality against your face needs checking
once you run it yourself.

## Verified end-to-end (not just "should work")

Beyond the unit-level `observerBroadcast.test.ts`, this was checked against
a real running Core process, not just in isolation: `bun run src/index.ts`
started for real, this page opened in an actual browser against it, and a
real device connected and registered over Core's real WebSocket protocol
— the page's status genuinely flipped from `DEMO` to
`LIVE · CONNECTED TO CORE` and displayed the real `device.registered`
event, with no mocking on either side. The same real-Core check was
repeated for `/status`: `TOOL REGISTRY` showed the real `2 REGISTERED`
tools, `DEVICES` correctly read `0/1 ONLINE` after a real device
registered but before it was paired/approved, and `OBSERVERS` showed
`1 CONNECTED` for the page's own socket. This is also how a real CORS bug
was caught and fixed — the endpoint worked correctly over curl while the
browser silently blocked the page from reading it, until
`Access-Control-Allow-Origin` was added.

Performance was measured, not assumed, on the earlier particle-based build:
~33fps sustained with **SwiftShader** (CPU software OpenGL — no GPU at
all, the worst realistic case) rendering ~26,000 additive-blended
particles at 1200x800. The current Core build is a fraction of that
geometry (two low-segment-count sphere wireframes, ~900 brain particles,
two rings) — not re-measured with an exact fps number since switching, but
expect it to be comfortably faster. Any actual GPU, including an
integrated one, clears 60fps easily either way.

## Accessibility & responsive layout

- `prefers-reduced-motion: reduce` turns off every continuous motion
  source — the plinth pulse/cursor-blink CSS animations, the Core's idle
  rotation/breathing/per-dot pulse, ring rotation, and periodic glitch
  bursts stop scheduling entirely. Voice-reactive and thinking-reactive
  brightness/scale changes stay on, since those are direct responses to
  real signals rather than ambient decoration.
- A real `<=600px` layout (verified at 390x844, iPhone-sized, plus
  820x1180 tablet-portrait and 1024x700 narrow-landscape): panels shrink
  and drop their bar meters, the activity header stacks instead of
  overlapping its status text, and title/plinth text scale down.
  **This used to just be a claim** — actually screenshotting 390x844
  turned up two real defects an untested "<=600px" media query had missed
  entirely: the Core's on-screen size is driven by the camera's fixed
  vertical FOV, which ties it to viewport *height* alone, so on a narrow
  *portrait* phone (width the real limiting dimension) it swallowed the
  whole screen width and rendered directly on top of both side panels —
  "VOICE" was unreadable, sitting mid-mesh. Fixed with
  `responsiveCamDistance()`: the camera pulls back further, proportional
  to how much narrower width is than height, whenever width < height —
  a no-op on every desktop/landscape viewport (where height was already
  the limiting dimension, matching the original tuning exactly), so this
  changes nothing about the framing already approved for desktop. Second,
  separate defect: the mic/face-tracking buttons kept their desktop
  bottom-corner position and ran directly into the "PERSONAL AI · CORE
  OFFLINE" plinth text at phone heights — fixed by repositioning them and
  capping the plinth text's width so it wraps instead of reaching that far
  right. Both found and fixed by actually rendering the breakpoint, not by
  reading the media query and assuming it worked.
- The mic and face-tracking controls are real `<button>` elements, not
  styled `<div>`s pretending to be buttons (which is what they actually
  were before this pass — reachable by mouse only, invisible to a
  keyboard). A real `<button>` gets keyboard focus, Enter/Space
  activation, and a real accessible name for free from the browser, none
  of which a `<div>` with a click handler provides no matter how it's
  styled. A `:focus-visible` ring was added (rather than the usual mistake
  of stripping the default outline for looks) so tabbing to either control
  is actually visible — verified with a real keyboard-only Playwright
  pass: `Tab` reaches each button, `Enter`/`Space` activates it, no mouse
  click involved.
- Not done: broader screen-reader semantics beyond the two real buttons
  above (this is still primarily a visual HUD; the telemetry panels and
  Core itself have no screen-reader-relevant equivalent today).

## Known limitations

- No automated visual-regression testing (a pixel/perceptual diff against
  a reference screenshot) — verification today is a manual
  render-and-look pass each time, described above.
- Face tracking is 2D box-position tracking, not 3D head-pose estimation,
  and needs a local HTTP server (not `file://`).
- Face-tracking accuracy against a real human face hasn't been checked in
  this dev environment (no physical camera available) — only the
  pipeline's plumbing (model load, permissions, fallback behavior) was
  verified against a real (synthetic-pattern) camera stream.
- There is no "listening" state (see "Reactivity" above) — deliberately,
  since there's no real signal in Core yet to drive one honestly.
- Real TTS now exists in the browser (Web Speech API's `SpeechSynthesis`,
  wired up in VOICE MODE) — it speaks JARVIS's actual reply text, not a
  placeholder. It's browser-side, not Core-generated audio: Core has no
  server-side text-to-speech of its own (the phone gateway's spoken
  replies go through Twilio's own `<Say>` TTS instead, a separate path).
- Real, scoped UI automation exists now too, beyond the original narrow
  set (`OPEN_URL`/`OPEN_APPLICATION`/`COMPOSE_EMAIL_DRAFT`): `CLICK_ELEMENT`
  (via the Accessibility API, by accessible label — never raw
  coordinates) and `TYPE_TEXT` (via `CGEvent` keystroke simulation) are
  both CONFIRM-level, requiring a fresh human confirmation on every
  single call with no standing grant able to bypass it — see the root
  `README.md`'s "Security controls" for the full reasoning. Still no
  generic "run this shell command"/AppleScript tool, and never will be —
  every capability, including these two, is a named, compiled-in Swift
  function with its own validation, not an interpreter for arbitrary
  instructions. Whatever real tool Jarvis does call shows up live in the
  CORE ACTIVITY feed above with its actual arguments and result, which is
  the concrete "let me see it happen" this page can honestly deliver
  today.
