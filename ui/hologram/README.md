# JARVIS hologram visualizer

A standalone holographic "face" HUD, in the style of a sci-fi AI interface:
a real human head/neck/shoulders 3D scan rendered as a glowing wireframe in
Three.js, side telemetry panels, a glowing base plinth labeled JARVIS, and
an occasional glitch/warning-banner effect.

## Running it

No build step — it's a self-contained page. Just open it directly:

```
open ui/hologram/index.html
```

(or double-click it in Finder). `three.min.js` is vendored locally in this
folder on purpose, not loaded from a CDN, so the visualizer works offline —
appropriate for a local personal-assistant UI that shouldn't depend on
internet access just to render its own face. The head model itself
(`headmodel/LeePerrySmith.b64.js`) is embedded as base64 and parsed
in-memory rather than fetched, for the same reason `fetch()` for local
files is blocked under `file://` (see the face-tracking gotcha below) —
embedding it keeps the base page's "just open the file" promise intact.

**Face tracking (👁 ENABLE FACE TRACKING) is the one thing that still needs
a local server, not `file://`.** Chromium blocks `fetch()` for local files
under the `file://` origin (this is what loads the face-tracking model
weights) even though `<script src>` tags are exempt from that restriction
(which is how the head model above avoids the same problem — embedded and
parsed, not fetched). There's no way around this for face-tracking's
weight files that isn't misleading, so: run any static server from this
folder and open it over `http://` instead —

```
python3 -m http.server 8080   # from ui/hologram/
# then open http://localhost:8080/
```

Clicking the button while on `file://` shows an explicit
`NEEDS LOCAL SERVER` message instead of a silent/confusing failure.

## How the face is built

**It's a real human head, not sculpted geometry.** After several rounds of
procedurally deforming a sphere — taper curves for a jaw, bumps for a
brow/nose/cheeks, hand-drawn contour lines for eyes/nose/cheeks/ears —
kept re-introducing "alien" cues one at a time (a bulbous crown, a funnel
chin, wrong proportions, no real ears), the actual fix was to stop
approximating a human head and use one:

- The scan's real bust is **cropped at the neck** (`clipTrianglesByY`/
  `clipPointsByY` in `index.html`, cutting anything below a fixed height
  in the source mesh) before any of the layers below are built. The
  reference is a slender neck fading to almost nothing near the bottom of
  frame; LeePerrySmith's real shoulders are wide and square, and once the
  head shape/grid/fill were otherwise settled this was the single
  biggest remaining silhouette mismatch — a width probe by height band
  (logged during development) showed the neck stays a fairly constant
  ~2.3-2.7 units wide up to the cutoff, then flares to 7-8.5 units for
  the actual shoulders just below it.
- A soft, glowing translucent **fill** of the whole (now neck-cropped)
  head/neck volume sits behind the grid (a `THREE.MeshBasicMaterial`,
  additively blended, double-sided, using the same cropped geometry).
  Without it, the wireframe read as a hollow cage around empty black
  space; the reference's head reads as a solid glowing mass with a grid
  on top.
- A large, soft-edged `THREE.Sprite` behind the head fakes the outward
  **bloom halo** the reference has — real bloom needs
  `EffectComposer`/`UnrealBloomPass`, not available in this vendored r128
  setup. Uses its own gradient texture (`haloTex`) with several gradual
  falloff steps rather than the small accent-dot sprite texture used
  everywhere else on the page — reusing that one at this large a scale
  showed a visible hard-edged circle instead of a soft ambient wash.
  Positioned well behind the face (not near the brain) so its cyan tint
  doesn't wash the brain's amber out toward white, which an earlier,
  closer placement did.
- **[LeePerrySmith](https://github.com/mrdoob/three.js/tree/master/examples/models/gltf/LeePerrySmith)**
  — a real facial-capture scan (head, neck, and shoulders) distributed
  with Three.js's own official examples, vendored locally under
  `headmodel/` (both as the original `.glb` and as a base64-embedded
  `.b64.js` — see "Running it" above for why).
- Decimated from its native ~17,700 triangles down to ~9,000
  (`THREE.SimplifyModifier`, after `THREE.BufferGeometryUtils.mergeVertices`)
  — dense enough to match the reference's fully-covered facial grid, while
  still reading as line art rather than a solid-shaded scan.
- Rendered with a **real latitude/longitude grid computed on the mesh's
  actual surface** (`buildLatLongOnMesh` in `index.html`), not
  `THREE.EdgesGeometry`. EdgesGeometry follows the mesh's own (irregular,
  post-decimation) triangulation — direct comparison against the reference
  showed that once dense enough to cover the whole face, that reads as a
  chaotic tangle around the eyes/nose/mouth, not the reference's smooth,
  evenly-spaced wrap. `buildLatLongOnMesh` instead walks every triangle,
  computes a spherical angle (latitude/longitude around a fixed center
  near eye-height) per vertex from its real 3D position, and interpolates
  exactly where each triangle edge crosses a fixed angle step — producing
  continuous grid lines that follow the real anatomy's curvature. The
  model's own UV atlas was checked first and isn't usable for this: it's a
  multi-island unwrap (eyes/nose/mouth/ears/scalp are separate radial
  charts for texturing), which would draw as fragmented concentric loops
  per island instead of one continuous grid.
  - Four ellipsoid **cavity zones** (the two eye sockets, the mouth, and
    the nostrils — the nostrils are their own small concave cavity, easy
    to miss since they sit in the gap between the eye and mouth zones)
    mark where this mesh's real open-mouth/eye-socket/nostril geometry is
    concave enough (depth folds back on itself) that the lat/long grid's
    spherical angle stops being monotonic, tangling the grid lines there
    — no angle-threshold or edge-length filter fixed that. The **grid**
    hard-excludes any triangle with a vertex in these zones
    (`excludeTriangles` in `index.html`); the custom eye sphere/glow and
    mouth line cover the resulting gap. The **solid fill mesh** instead
    uses a **soft per-vertex alpha fade** (`computeFadeAttribute`, applied
    via `fillMat.onBeforeCompile`) that smoothly dims to fully transparent
    approaching each zone's center — this went through two failed
    attempts first: a hard cut on the fill mesh left the cut's own
    boundary edge visible as a distinct bright contour (seeing the inside
    rim of the hole), and *not* cutting the fill at all let this scan's
    real, separately-sculpted eyeball spheres (common on face-scan/rig
    assets) show straight through undimmed — both read as "visible
    circles in the face," at any zone size. Only a gradual fade, not a
    hard edge either way, actually fixed it. A decorative flat "mouth
    grid patch" of procedural accent lines was also tried to fill the
    grid's excluded mouth area and reverted — it read as "a hole with
    bars over it," not simpler than the problem it covered; the existing
    mouth line alone, over the now-smoothly-faded fill, reads closer to
    the reference's simple closed lips.
  - Two further, progressively larger and dimmer copies of the same line
    geometry (`glowLines`/`glowLines2`, scale 1.03/1.07, opacity
    0.28/0.12, additive blending) are drawn behind the bright original as
    a cheap "poor man's bloom" — there's no `EffectComposer`/
    `UnrealBloomPass` in this vendored setup, so the glow is faked by
    literally re-drawing the lines slightly bigger and fainter underneath
    (one extra layer wasn't enough spread compared to the reference).
  - A cyan-blue node dot (`THREE.Points`, color `0x6fd8e8`, size 0.03,
    opacity 0.65) sits at every vertex of the cropped mesh — the same
    cyan the very first particle-based build (before any of the "alien"
    head-shape rounds) used for its face dots, brought back once the head
    *shape* itself was settled and the user asked for that "internals"
    texture again. Deliberately still well under the size/opacity that
    fused into a solid mass at this vertex density in an earlier round
    (that earlier round used plain white, not cyan, at 0.05/0.9 — this is
    bluer *and* smaller/dimmer than that).
- Two small, additively-blended spheres for the "pupil" glint, positioned
  at the real eye-socket coordinates (found by raycasting the source mesh
  at the visually-identified eye locations, not guessed), each backed by
  a soft-glow `THREE.Sprite` stretched horizontally into an almond shape.
  Both went bigger then smaller across rounds: a first pass was too
  subtle to be a focal point, but a later, bigger, fully-opaque sphere is
  what actually read as "a visible ball stuck in the face" rather than an
  eye — small, blended, and paired with the fade above (not a hard cut)
  is what settled it: a bright core sitting *in* the face, not its own
  separate shape.
- A single small glint at the nose tip mimics the specular highlight a
  protruding surface would catch under real lighting — this page's
  wireframe/fill is flat, unlit line art with no actual light-and-shadow,
  which is why the nose (correct in the underlying geometry) read as
  flatter than the reference's clearly protruding one. One deliberate
  accent, not a lighting model rewrite.

## Proportions: lens choice and a non-uniform scale, not just the mesh

Two further, non-geometry fixes closed a "this still reads as fake/
bloated compared to the reference" gap that direct side-by-side
comparison traced to *how the head is framed*, not just what it's made
of:

- **A narrower camera FOV (45°→28°) at a proportionally greater
  distance** (same on-screen framing, not a zoomed-in change) — a wide
  FOV this close to a face exaggerates its real width/roundness, the
  same well-known reason portrait photographers avoid shooting close
  with a wide-angle lens. The reference reads as flatter/more
  telephoto-compressed; this page's camera was doing the opposite.
- **A non-uniform scale on the head model itself** (narrower in x,
  taller in y: `0.86x, 1.12y, 0.97z` relative to the base 0.384 scale) —
  LeePerrySmith is a real adult male face and was never going to become
  a slender idealized oval through camera framing alone, so the model is
  squashed/stretched slightly to match the reference's proportions more
  directly. This also pulls the ears in rather than needing separate
  treatment for them. Trade-off: a perfect sphere (the eye pupils) reads
  as a very slightly squashed ellipsoid under this same non-uniform
  scale, since they're children of the same scaled group — not visually
  significant at the sizes/distances involved, but a real, known
  side-effect rather than a free fix.

Real ears, a real nose, a real jaw, a real neck-into-shoulders — all
inherent to the geometry, from any angle, with no per-feature code needed
to fake them. This also **removed** a lot of code rather than adding it:
the old procedural face mask, particle-cloud sampling, sphere taper/bump
sculpting, and hand-built eye/nose/cheek/ear contour lines are all gone —
a real mesh made most of that machinery unnecessary.

## A visible brain, not an empty shell

The wireframe is just line edges, so anything placed inside the head
volume is naturally visible through it — a warm amber cloud of ~1,800
points filling most of the actual cranial cavity (from brow to crown),
plus 80 connecting "synapse" line segments, gives the head genuine
internal structure instead of reading as a hollow dome or a small patch.
Sized up substantially from an original ~900-point, much smaller volume
per direct user feedback that it looked "really small" relative to the
head — a first, bigger attempt leaked particles through the scalp near
the crown (the real skull narrows faster there than a simple ellipsoid
assumes), so the final size/position was pulled in slightly to stay
inside the actual mesh surface, verified via zoomed-in screenshots.

Its glow, and now its **size**, aren't a fixed animation: `brainPulse`
(in `index.html`) brightens *and physically grows* the brain on real
`brain.request`/`brain.response` activity from the observer feed (or the
labeled demo feed when Core is offline) and decays back to a gentle idle
baseline — so it's visibly "thinking harder" (bigger and brighter, not
just brighter) exactly when Jarvis actually is, per direct user request.

**Never fully static, even at rest**: every brain particle continuously
drifts on its own sine cycle (not a fixed structure that only moves on
real events) and individually grows/shrinks in size on its own random
phase (see "Individually pulsing dots" below), and ~4 of the 80 synapse
lines re-wire to new random points every ~1.1s, so the connections
visibly re-form over time like real firing. The whole head also has a
subtle continuous idle sway (rotation) and a faint "breathing" scale
pulse, a little stronger while brainPulse is high — all gated off under
`prefers-reduced-motion`, same as every other continuous motion source
on this page.

## Individually pulsing dots — not a field of fixed-size points

Per direct user request (comparing to Iron Man/real-Jarvis-style HUDs):
every glowing dot — the face's surface node dots and the brain's points
alike — individually grows and shrinks over time on its own random
phase, rather than every dot in the field being one fixed size or
pulsing together in lockstep. `addSizePulse()` in `index.html`
implements this by patching the one `gl_PointSize = size;` line in
Three.js's own built-in points vertex shader (present verbatim across
versions, including this vendored r128) via `material.onBeforeCompile`,
multiplying it by a per-vertex sine term driven by a `uTime` uniform and
a random `aPhase` attribute — chosen over writing a full custom
`ShaderMaterial` from scratch so Three's existing perspective
size-attenuation math keeps working for free. Frozen (not ticking
`uTime`) under `prefers-reduced-motion`, same as every other continuous
motion source.

## The eyes, mouth, and nostrils: a soft fade, not a hole or a hard cut

The most persistent gap across several rounds was the mouth/eye area
reading as "fake" — first a big empty hole (an oversized exclusion zone),
then an ugly tangle (real open-mouth/eye-socket geometry breaking the
grid's angle math), then, after fixing the grid, "visible circles in the
face" once it turned out the *solid fill mesh* needed the same treatment
as the grid but a hard cut there left its own boundary edge visible, and
skipping the cut let this scan's real sculpted eyeball spheres show
through instead. The fix that actually worked (see "How the face is
built" above for the exact mechanism): the grid keeps a hard exclusion
cut (covered by the custom eye/mouth accents), but the fill mesh uses a
**gradual per-vertex alpha fade** toward each cavity's center instead of
either extreme — no hole, no hard edge, no real eyeball geometry showing
through. A decorative flat line-patch over the mouth's excluded grid area
was also tried and reverted (see below) — simpler won over "trying to
look like real geometry."

## Viewing it from any angle — drag to orbit

Click-and-drag anywhere on the page to rotate the camera freely around the
head (mouse wheel to zoom); it's real 3D geometry with a genuine back and
sides, not a flat front-only sprite. This is separate from webcam face
tracking below: **orbiting moves the camera** around a head that stays
put, so you can inspect it from any side; **face tracking rotates the
head itself** to face wherever your tracked face is. Both can be in play
at once — dragging the camera to the side while face-tracking is on still
lets the head turn toward your actual face, which is a different thing
from the camera's current viewing angle. There's no way to make the head
*both* always face the viewer *and* be freely orbitable to see its back
at the same time — that's a contradiction, not an engineering gap — so
this splits them into two honest, separate controls instead of faking one.

Before the real head mesh (see "How the face is built" above), the old
procedurally-sculpted sphere had real problems that only showed up once
this orbit control existed — a stray particle "spike" past the crown/chin
and a chin that funneled to a mathematical point, both invisible from the
fixed front-only view this replaced. A real mesh has a real back and
sides by construction, so there's nothing equivalent to fix now — orbit
just works, from any angle.

## Background depth

The background is no longer a flat gradient alone: a cheap 2D-canvas
"matrix rain" of falling characters runs behind the WebGL scene (frozen to
a static frame under `prefers-reduced-motion` instead of animating
forever), plus a handful of blurred vertical light strips and blinking LED
dots standing in for distant server racks — pure CSS, no extra geometry.
This is still nowhere near a photoreal 3D-rendered room (see "Visual
fidelity" below for why that specific gap is out of scope for a live
page), but it replaces "empty void" with an actual sense of depth.

## Live "CORE ACTIVITY" feed — real, not simulated, once Core is running

The bottom panel connects to a real, new read-only endpoint on Core:
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

**When Core is offline** (which is the common case right now — Phase 2 has
no long-running deployment yet), the panel honestly falls back to a
clearly-labeled `DEMO` feed of representative events, so it's never
ambiguous whether what's on screen is real.

## Real dashboard numbers, not decoration — TOOL REGISTRY / DEVICES / OBSERVERS

The two side panels also poll a second new endpoint, **`GET /status`**
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
request reaches Core fine (curl-testing it looks correct while the page
still shows `NO DATA` — check this header first if that happens again).
Covered by `tests/integration/statusHttp.test.ts`.

Covered by `tests/integration/observerBroadcast.test.ts`.

## Voice reactivity — real audio analysis, no TTS to plug it into yet

The head visibly pulses (strongest around the mouth/jaw) in response to
live audio via the Web Audio API (`AnalyserNode`) — genuine
frequency-domain analysis, not a fake animation loop. `window.JarvisHologram`
exposes two real integration points for whenever Core gets a voice/TTS
output:

- `connectAudioElement(mediaEl)` — feed it an `<audio>`/`<video>` element
  playing Jarvis's speech.
- `connectMediaStream(stream)` — feed it a raw `MediaStream` (e.g. a
  WebRTC or streaming-TTS pipeline).

**Core has no TTS/voice output at all yet** (checked — nothing in `src/`
does speech synthesis), so there's nothing genuine to auto-connect to
today. The "🎙 CONNECT MIC" button in the bottom-right is a real, working
way to see the reactivity live right now — it feeds your actual
microphone in, which is honest proof the mechanism works rather than a
placeholder pretending to be voice output.

## Webcam face tracking — the head turns to face you, for real

Click **👁 ENABLE FACE TRACKING** (needs a local server — see "Running it"
above) and grant camera access. This runs real face detection —
[face-api.js](https://github.com/vladmandic/face-api) with the tiny-face
detector + 68-point landmark model, vendored locally under
`facetrack/` (~1.6MB total, no CDN) — not a scripted "always looks at
center" loop. While a face has been seen in the last 1.5 seconds, the
head's rotation is driven by the tracked face's position in frame (turning
toward wherever you are, mirror-style, as if maintaining eye contact) and
smoothly falls back to its idle sway the moment you step out of frame.
Detection runs roughly every 120ms in a plain polling loop, independent of
the render loop, so a slow detection frame never stalls the animation.

**Honest limits**: this is 2D face-box tracking (yaw/pitch approximated
from where the detected face sits in the frame), not full 3D head-pose
estimation — a real, working head-follow, not a claim of anatomically
precise gaze tracking. It also could not be verified against a real human
face in this sandboxed dev environment (no physical camera; Playwright's
fake-camera device produces a synthetic test pattern, not a face), so
what's verified here is that model loading, camera permission, and the
graceful "no face seen" fallback all work correctly against a real
running pipeline — the actual tracking quality against your face needs
checking once you run it yourself.

## Lip movement + a WhatsApp-style voice meter — both real audio, not decoration

- **Mouth line**: a distinct upper/lower lip line, positioned at the head
  model's real mouth coordinates, that visibly opens while audio is loud
  and closes to flat at silence — driven every frame by the real
  analyser level, not a separate fake animation.
- **Voice bars** (`#voice-bars`, above the plinth): a small bar-meter in
  the exact style of a WhatsApp voice-message waveform, scrolling in real
  time from the same `AnalyserNode`. It's a flat near-zero line whenever
  nothing is connected — never a fabricated idle waveform — and lights up
  green the moment the mic (or, later, TTS output) is connected.

Both use the existing `window.JarvisHologram.connectAudioElement()` /
`connectMediaStream()` hooks, so whenever Core gets real TTS output, both
the mouth and the voice bars start reflecting Jarvis's actual speech with
no code changes needed here.

## Visual fidelity vs. the reference video/images

Frames were pulled from the actual reference video (and a second real
Jarvis product demo the user sent for comparison) and compared directly
against screenshots of this page (not "should look similar" — an actual
side-by-side) to find concrete, fixable gaps rather than guessing. That
went through several rounds: wireframe/mesh grid vs. a particle-noise
cloud, alien-looking proportions, a missing brain, a pointed chin, no
ears, a triangulated-vs-clean grid — each one diagnosed from a specific
screenshot comparison, not a general "make it closer" guess. The last and
biggest of those rounds replaced procedural sphere-sculpting entirely with
a real human head/neck/shoulders scan mesh (see "How the face is built"
above), which fixed the remaining proportion/anatomy issues structurally
instead of one taper-curve tweak at a time. An earlier pass also added two
orbiting "data node" rings around the head, echoing one of the reference
video's other shots — removed again on request, since that specific shot
isn't the one this page is matching.

What's still, genuinely, out of reach for a live 60fps interactive page
without an unreasonable rendering budget: the reference is a one-shot
cinematic AI render with a fully photoreal 3D server room (real depth of
field, physical rack geometry, ray-traced reflections) and a physical
metal plinth — this page approximates that room with 2D depth cues
(blurred light strips, a matrix-rain backdrop) rather than a modeled 3D
environment. If specific remaining details still feel off, point at
exactly which ones from a current screenshot (not an older one — check the
timestamp/build first) — that's a more useful next step than a general
"make it closer" pass.

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
registered but before it was paired/approved (an accurate reflection of
Core's actual pairing state, not a rounding-up), and `OBSERVERS` showed
`1 CONNECTED` for the page's own socket. This is also how a real CORS bug
was caught and fixed — the endpoint worked correctly over curl while the
browser silently blocked the page from reading it, until
`Access-Control-Allow-Origin` was added.

Performance was measured, not assumed, on the earlier particle-based build:
~33fps sustained with **SwiftShader** (CPU software OpenGL — no GPU at
all, the worst realistic case) rendering ~26,000 additive-blended
particles at 1200x800. The current real-mesh build renders roughly 9,000 triangles' worth of
edges/points (plus a duplicated glow-line layer for the fake-bloom effect)
— still substantially lighter than the old particle build — but hasn't
been re-measured with an exact fps number since switching; expect it to be
at least as fast. Any actual GPU, including an integrated one, comfortably
clears 60fps either way.

## Accessibility & responsive layout

- `prefers-reduced-motion: reduce` turns off every continuous motion
  source — the plinth pulse/cursor-blink CSS animations, the shader's
  idle drift and glitch displacement, head/ring auto-rotation, and
  periodic glitch bursts stop scheduling entirely. Voice-reactive
  pulsing stays on, since that's a direct response to real audio input
  rather than ambient decoration.
- A real `<=600px` layout (verified at 390x844, iPhone-sized): panels
  shrink and drop their bar meters, the activity header stacks instead of
  overlapping its status text, and title/plinth text scale down. Checked
  for horizontal overflow and readability, not just "doesn't crash."
- Not done: screen-reader semantics (this is a purely visual HUD with no
  screen-reader-relevant content today) and touch-specific interactions
  (the mic button works via a plain click/tap, nothing more elaborate is
  needed yet).

## Known limitations

- This is a live interactive page, not a one-shot cinematic render — see
  "Visual fidelity" above for why exact parity with an AI-generated
  reference video isn't the right bar.
- No automated visual-regression testing (a pixel/perceptual diff against
  a reference screenshot) — verification today is a manual
  render-and-look pass each time, described above.
- Face tracking is 2D box-position tracking, not 3D head-pose estimation,
  and needs a local HTTP server (not `file://`) — see the face-tracking
  section above for both.
- Face-tracking accuracy against a real human face hasn't been checked in
  this dev environment (no physical camera available) — only the
  pipeline's plumbing (model load, permissions, fallback behavior) was
  verified against a real (synthetic-pattern) camera stream.
- The head model (`headmodel/LeePerrySmith.glb`) is a facial-capture scan
  of one specific real person, distributed with Three.js's own official
  examples — it isn't a generic/synthetic avatar. It's used purely as
  wireframe/point geometry here (no photo texture applied), same spirit
  as any other third-party mesh used as a technical asset.
- The lat/long grid's eye/mouth/nostril exclusion zones (see "How the
  face is built") leave a visibly rougher boundary right at their edge —
  cutting a hole in the grid necessarily leaves the neighboring iso-lines
  dangling instead of continuing smoothly, most noticeable around the
  nose/upper-lip area from a 3/4 or side angle. The custom eye/mouth
  accents and the fill mesh's soft fade cover most of it from the front,
  which is the primary viewing angle, but this is a real, visible
  remaining gap in the grid layer specifically, not a solved one.
- The non-uniform model scale (see "Proportions" above) squashes the eye
  pupil spheres very slightly into ellipsoids, since they're children of
  the same non-uniformly scaled group — not visually significant at the
  sizes/distances involved, but a real, known side-effect.
