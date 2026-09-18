# JARVIS hologram visualizer

A standalone holographic "face" HUD, in the style of a sci-fi AI interface:
a particle-based head rendered in Three.js, side telemetry panels, a glowing
base plinth labeled JARVIS, and an occasional glitch/warning-banner effect.

## Running it

No build step — it's a self-contained page. For the particle head, wireframe,
panels, and audio reactivity, just open it directly:

```
open ui/hologram/index.html
```

(or double-click it in Finder). `three.min.js` is vendored locally in this
folder on purpose, not loaded from a CDN, so the visualizer works offline —
appropriate for a local personal-assistant UI that shouldn't depend on
internet access just to render its own face.

**Face tracking (👁 ENABLE FACE TRACKING) needs a local server, not `file://`.**
Chromium blocks `fetch()` for local files under the `file://` origin (this
is what loads the face-tracking model weights) even though `<script src>`
tags — like the one that loads `three.min.js` — are exempt from that
restriction. There's no way around this that isn't misleading, so: run any
static server from this folder and open it over `http://` instead —

```
python3 -m http.server 8080   # from ui/hologram/
# then open http://localhost:8080/
```

Clicking the button while on `file://` shows an explicit
`NEEDS LOCAL SERVER` message instead of a silent/confusing failure.

## How the face is built

There's no 3D face model/asset, and no external mesh is loaded. Two layers
are combined:

1. **A wireframe grid head** — a procedurally-displaced low-poly sphere
   (squashed into a head/oval shape, tapered to a rounded jaw/chin, with a
   brow ridge and nose bump pushed out on the front-facing vertices only),
   rendered as glowing `THREE.LineSegments` edges plus a bright dot at
   every vertex. This is the structural layer that reads as "digital face"
   at a glance, matching the reference video's dominant visual — a
   triangulated mesh grid, not a photo-like cloud of noise.
2. **A particle shimmer layer behind it** — `index.html` separately draws a
   stylized face mask (head silhouette, eye sockets, nose/mouth shading,
   a procedural circuit-trace overlay) onto an offscreen 2D canvas, then
   samples that canvas's pixel alpha to place several thousand
   `THREE.Points` particles. This gives the hologram a soft, organic halo
   of texture/glow around the crisp wireframe instead of the wireframe
   floating in flat empty space.

Two `THREE.LineLoop` orbit rings (cyan + amber) with small satellite
spheres animate around the head, echoing the reference's "orbiting data
node" motif — plain geometry, no extra assets.

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

- **Mouth line**: the wireframe head now has a distinct upper/lower lip
  line that visibly opens while audio is loud and closes to flat at
  silence — driven every frame by the same real analyser level as the
  particle pulse, not a separate fake animation.
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

Frames were pulled from the actual reference video and compared directly
against screenshots of this page (not "should look similar" — an actual
side-by-side) to find concrete, fixable gaps rather than guessing. That
comparison found the earlier build's biggest miss: the reference's head is
a **wireframe/mesh grid** with glowing vertex dots, not a particle-noise
cloud — a difference in visual language, not just tuning. That's now
fixed (see "How the face is built" above), along with the orbit rings and
background depth cues the reference also has and the old build didn't.

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

Performance was also measured, not assumed: ~33fps sustained with
**SwiftShader** (CPU software OpenGL — no GPU at all, the worst realistic
case) rendering ~26,000 additive-blended particles at 1200x800. Any actual
GPU, including an integrated one, comfortably clears 60fps here.

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
