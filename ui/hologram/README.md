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

- **[LeePerrySmith](https://github.com/mrdoob/three.js/tree/master/examples/models/gltf/LeePerrySmith)**
  — a real facial-capture scan (head, neck, and shoulders) distributed
  with Three.js's own official examples, vendored locally under
  `headmodel/` (both as the original `.glb` and as a base64-embedded
  `.b64.js` — see "Running it" above for why).
- Decimated from its native ~17,700 triangles down to ~3,000
  (`THREE.SimplifyModifier`, after `THREE.BufferGeometryUtils.mergeVertices`)
  — sparse enough to read as a clean HUD grid instead of a dense scan.
- Rendered as `THREE.EdgesGeometry(simplified, 20)` — this keeps only
  edges between faces whose normals differ by more than ~20°, which is
  what makes the nose bridge, eye-socket rims, lips, and jawline read as
  clean contour lines instead of a busy triangulated mesh — plus a bright
  node dot (`THREE.Points`) at every remaining vertex.
- Two small bright spheres for the "pupil" glint, positioned at the real
  eye-socket coordinates (found by raycasting the source mesh at the
  visually-identified eye locations, not guessed).

Real ears, a real nose, a real jaw, a real neck-into-shoulders — all
inherent to the geometry, from any angle, with no per-feature code needed
to fake them. This also **removed** a lot of code rather than adding it:
the old procedural face mask, particle-cloud sampling, sphere taper/bump
sculpting, and hand-built eye/nose/cheek/ear contour lines are all gone —
a real mesh made most of that machinery unnecessary.

## A visible brain, not an empty shell

The wireframe is just line edges, so anything placed inside the head
volume is naturally visible through it — a warm amber cloud of ~900
points filling most of the cranium, plus a handful of connecting
"synapse" line segments, gives the head genuine internal structure
instead of reading as a hollow dome. Its glow isn't a fixed animation:
`brainPulse` (in `index.html`) brightens on real `brain.request`/
`brain.response` activity from the observer feed (or the labeled demo
feed when Core is offline) and decays back to a gentle idle breathing
glow — so it's visibly "thinking harder" exactly when Jarvis actually is.

**Never fully static, even at rest**: every brain particle continuously
drifts on its own sine cycle (not a fixed structure that only moves on
real events), and ~4 of the 46 synapse lines re-wire to new random points
every ~1.1s, so the connections visibly re-form over time like real
firing. The whole head also has a subtle continuous idle sway (rotation)
and a faint "breathing" scale pulse, a little stronger while brainPulse
is high — all gated off under `prefers-reduced-motion`, same as every
other continuous motion source on this page.

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
particles at 1200x800. The current real-mesh build renders roughly
1,500-3,000 vertices' worth of edges/points total — substantially lighter
— but hasn't been re-measured with an exact fps number since switching;
expect it to be at least as fast. Any actual GPU, including an integrated
one, comfortably clears 60fps either way.

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
