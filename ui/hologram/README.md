# JARVIS hologram visualizer

A standalone holographic "face" HUD, in the style of a sci-fi AI interface:
a particle-based head rendered in Three.js, side telemetry panels, a glowing
base plinth labeled JARVIS, and an occasional glitch/warning-banner effect.

## Running it

No build step, no server required — it's a single self-contained page:

```
open ui/hologram/index.html
```

(or double-click it in Finder). `three.min.js` is vendored locally in this
folder on purpose, not loaded from a CDN, so the visualizer works offline —
appropriate for a local personal-assistant UI that shouldn't depend on
internet access just to render its own face.

## How the face is built

There's no 3D face model/asset. `index.html` draws a stylized face mask
(head silhouette, eye sockets, nose/mouth shading) onto an offscreen 2D
canvas, then samples that canvas's pixel alpha to place several thousand
`THREE.Points` particles — brighter pixels get more/brighter particles.
That's what gives the hologram its organic, non-uniform density instead of
looking like a flat cutout.

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

## Visual fidelity vs. the reference video/images

The reference was a cinematic AI-generated render (single high-detail
frames) — this is a live, 60fps interactive page. It gets close in
concept and mood (particle/wireframe holographic head, dark scene, side
telemetry, glowing base, periodic glitch) but won't be a pixel-exact match
to a one-shot render without an unreasonable real-time rendering budget.
If specific details still feel off, point at exactly which ones — that's
a more useful next step than a general "make it closer" pass.

## Known limitations

- This is a visual mockup, not a production HUD — there's no accessibility
  handling (screen readers, reduced-motion) and no mobile/touch layout.
- Rendering ~15,000 additive-blended particles is comfortable on a modern
  GPU but untested on low-power hardware; drop the particle target in
  `sampleParticles(mask, MASK_SIZE, 15000)` if it stutters.
