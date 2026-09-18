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

- **Outer shell** — a `THREE.SphereGeometry` rendered as a `WireframeGeometry`
  lat/long grid (cyan/white), plus a second, larger and dimmer copy behind
  it for a cheap "poor man's bloom" (no `EffectComposer`/`UnrealBloomPass`
  in this vendored r128 setup) — the same glow-duplication technique used
  throughout this page. Individually-pulsing dots (`addSizePulse`, see
  below) sit at every vertex.
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

## Voice reactivity — real audio analysis, no TTS to plug it into yet

The Core visibly brightens, grows, and spins faster in response to live
audio via the Web Audio API (`AnalyserNode`) — genuine frequency-domain
analysis, not a fake animation loop. `window.JarvisHologram` exposes two
real integration points for whenever Core gets a voice/TTS output:

- `connectAudioElement(mediaEl)` — feed it an `<audio>`/`<video>` element
  playing Jarvis's speech.
- `connectMediaStream(stream)` — feed it a raw `MediaStream` (e.g. a
  WebRTC or streaming-TTS pipeline).

**Core has no TTS/voice output at all yet**, so there's nothing genuine to
auto-connect to today. The "🎙 CONNECT MIC" button in the bottom-right is a
real, working way to see the reactivity live right now — it feeds your
actual microphone in, which is honest proof the mechanism works rather
than a placeholder pretending to be voice output.

A scrolling bar meter (`#voice-bars`, above the plinth) in the style of a
WhatsApp voice-message waveform draws from the same `AnalyserNode` in real
time — a flat near-zero line whenever nothing is connected, never a
fabricated idle waveform, lighting up green the moment the mic (or, later,
TTS output) is connected.

A second, separate **VOICE panel** sits on the right side of the screen
(below CORE STATUS) with its own 24-bar frequency spectrum
(`#voice-spectrum`). Unlike `#voice-bars` above, which shows one averaged
loudness value scrolling over time, this reads the same per-frame
`AnalyserNode.getByteFrequencyData()` array directly and draws each
frequency bin as its own bar — so you can actually see how the voice's
frequency content is shaped (bass-heavy vs. bright, a hard consonant vs. a
sustained vowel), not just how loud it is. Only the lower ~60% of the FFT's
bins are drawn, since that's where speech energy concentrates and the
upper bins would otherwise sit flat. Every bar renders at a small non-zero
floor height even at zero signal (so the panel always reads as "a
spectrum," not "a broken canvas") and brightens from a dim cyan-to-amber
gradient to a fully lit one the moment real audio is flowing — same
honesty rule as everywhere else on this page: dim/idle when nothing is
connected, never a fabricated animation. Its heading badge flips
IDLE → LIVE in sync with the mic connect button.

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
- A real `<=600px` layout (verified at 390x844, iPhone-sized): panels
  shrink and drop their bar meters, the activity header stacks instead of
  overlapping its status text, and title/plinth text scale down.
- Not done: screen-reader semantics (this is a purely visual HUD with no
  screen-reader-relevant content today) and touch-specific interactions
  (the mic button works via a plain click/tap, nothing more elaborate is
  needed yet).

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
- Core has no TTS/voice output yet — the mic button proves the voice
  mechanism live today, not real Jarvis speech.
- No autonomous computer control (the Core does not, and currently cannot,
  move around the screen or click on things on its own) — that would be a
  completely different system (OS-level automation, screen capture, input
  simulation) with real safety implications, out of scope for this page
  and not something to build without an explicit, scoped decision first.
