# JARVIS Core — hologram UI

Ground-up rebuild (2026-10-27), per David's explicit decision to discard the
previous wireframe-sphere/particle-flow-field/orbit-ring build entirely
rather than patch it. See the git history for the old file's own long
README if you want the previous build's full story — it isn't carried
forward here since none of that code survived the rebuild, only two
deliberately-kept assets (below).

## What this is

A real client of JARVIS Core's actual WebSocket/HTTP contract
(`src/communication/websocket/JarvisWebSocketServer.ts`) — not a mockup.
It shows:

- **The Core** — a single organic, glowing 3D form (a noise-displaced
  icosphere lit by a custom shader), reacting to JARVIS's real per-turn
  state machine.
- **Conversation** — a real two-way chat over `ws(s)://.../chat`, the same
  `orchestrator.handleUserMessage()` the CLI/phone/Telegram channels use.
- **System status** — devices/tools/observer counts polled from
  `GET /status`, honestly shown as `—`/`NO DATA` when unreachable.
- **Activity** — a live log of real EventBus events mirrored over
  `ws(s)://.../observer` (tool calls, provider fallbacks, goal-task
  transitions, etc.).
- **Voice** — continuous, hands-free listening and spoken replies (see
  "Voice Mode" below), not a push-to-talk button.

## Running it

Serve it from Core itself:

```
bun run src/index.ts
```

then open `http://localhost:4770/hologram/` (note the trailing slash —
see the comment on `HOLOGRAM_UI_DIR`'s route in
`JarvisWebSocketServer.ts` for why it matters: without it, the page's
relative `<script src="three.min.js">` etc. resolve against `/` instead
of `/hologram/` and silently 404).

It derives which Core to talk to from its own address — `?host=`/`?port=`/
`?secure=` if given, otherwise the origin it was served from, falling back
to `localhost:4770` for a bare `file://` open. Append `?token=...` when
`JARVIS_ADMIN_TOKEN` is configured on that Core.

No build step. `three.min.js` and the `postprocessing/`/`shaders/` files
(the official Three.js r128 example scripts, MIT-licensed, fetched from
the same release the vendored `three.min.js` is) are vendored locally —
same reasoning as the previous build: no CDN/runtime dependency.

## What's real vs. what's a deliberate client-side choice

Every state shown is backed by a real signal, never invented — but two
things are worth being explicit about:

- **The five-plus visual states are driven by `jarvis.liveState.changed`**
  (`src/core/state/JarvisLiveState.ts`), JARVIS's own real, server-side,
  enforced-transition state machine: `IDLE`, `LISTENING`, `THINKING`,
  `PLANNING`, `EXECUTING`, `VERIFYING`, `WAITING`, `SPEAKING`, `ERROR`,
  `STOPPED`. This page only reacts to transitions whose `sessionId` starts
  with `chat:` — the channel this page's own `/chat` connection uses —
  since the same EventBus also carries phone/SMS/Telegram/voice-gateway
  sessions, which are real but not this page's own conversation.
- **Spoken replies are real browser `SpeechSynthesis`** of JARVIS's actual
  reply text — Core has no server-side TTS today (confirmed against the
  real codebase, not assumed). The Core's "speaking" visual reacts to real
  utterance events (`onstart`/`onboundary`/`onend`), not a fabricated
  amplitude timer.
- **A failed tool call's one-off "needs attention" flash** is a local,
  client-only pulse triggered by a real `tool.executed` event with
  `result.success: false` — it is not itself a `jarvis.liveState.changed`
  transition to `ERROR` on the server, so it decays back to whatever the
  real server state is a moment later rather than sticking.

## Voice Mode — continuous, hands-free (2026-10-27)

Per David's explicit requirement — *"there's no permission/button I have
to press with, everything should always be by voice, nothing manual"* —
the mic button is a single **Voice Mode** toggle, not push-to-talk:

- **One tap turns it on.** That tap is the one truly unavoidable manual
  step: granting the browser's real microphone permission is a platform
  security requirement, not a design choice, and no web page can skip it.
- **After that, both directions are hands-free.** Listening runs
  continuously (`SpeechRecognition` with `continuous: true`,
  auto-restarting itself on every natural `end`/non-fatal `error` event)
  and spoken replies turn on together with it — one coherent mode, not two
  switches to manage. The speaker button remains as a secondary **mute
  for output only** (keep listening, stop talking back).
- **Echo avoidance.** While JARVIS is actually speaking, recognition is
  paused (`pauseListeningForPlayback`) and resumed on the real
  `SpeechSynthesisUtterance` `onend`/`onerror` — otherwise a continuously
  open mic would transcribe JARVIS's own reply back to itself.
- **Real, checked platform difference, not assumed:** desktop
  Chrome/Edge's `continuous` mode restarts itself cleanly and reliably.
  iOS Safari supports the same `webkitSpeechRecognition` API (since
  Safari 14.5) but real-world developer reports are consistent that
  `continuous` is unreliable there — it stops on its own after a short
  silence regardless of the flag ("the `continuous` feature is completely
  useless on iOS" is a direct quote from one such report; MDN and
  multiple independent sources agree Safari's implementation diverges
  from Chrome's here). This page handles both the same way — every
  `end`/non-fatal `error` triggers an automatic restart — which gives
  genuine gapless hands-free behavior on desktop, and the closest honest
  equivalent on iPhone: **one tap opens an ongoing session that keeps
  re-listening between utterances on its own**, not a fresh tap required
  per sentence, though each restart takes a brief real moment (not
  literally gapless the way desktop Chrome is). This was checked against
  current real documentation while building this, not asserted from
  memory.
- **No wake-word gate exists here** ("Hey JARVIS" is a separate, larger
  effort — see the project's own roadmap notes on two-stage local
  wake-word detection). Instead, a final transcript is only sent as a
  message if it contains "jarvis" (English) or a Hebrew wake variant
  (`ג'ארוויס`/`ג'רוויס`) — a simple client-side text filter, **not** the
  real wake-word system — so an always-open mic doesn't send every word of
  ambient room conversation to the assistant. This is a judgment call
  made during this build, flagged back to David rather than silently
  assumed; it's easy to remove (`WAKE_WORD_PATTERN` in `app.js`) if he'd
  rather have zero gating.
- **Not verified on a real device.** This sandbox has no real microphone
  or real iOS Safari to test against — what's verified here is that the
  continuous-listening/echo-avoidance/cleanup code paths run without
  errors against Playwright's fake media device (`enableVoiceMode` →
  `disableVoiceMode`, see `.verification-screenshots/`), not real speech
  recognition accuracy or iOS's actual restart timing. Flagged plainly
  rather than claimed.

## The Core's rendering technique

A displaced icosphere lit by a custom GLSL shader, not raymarched SDF
metaballs — both are legitimate real techniques for this "Siri-style
living core" category (the brief this was built from describes both).
Displaced geometry was chosen because it's materially cheaper (a single
mesh, no per-pixel raymarch loop) while reading as organic at a mesh
resolution real phone/Mac GPUs handle trivially — a real cost concern for
a page that has to run on an iPhone, not just a desktop.

**A real, measured finding worth recording**: this vendored Three.js
revision's `IcosahedronGeometry`'s `detail` parameter is **not** the
`4^detail` exponential recursive subdivision other Three.js
versions/tutorials describe — it subdivides each of the icosahedron's 20
base faces into `(detail+1)²` small triangles with no vertex welding
across faces (confirmed by reading the vendored `three.min.js` source,
then by directly measuring the real vertex count in a running page:
`detail 5` is genuinely only 720 triangles, not the ~3,400 a `4^detail`
assumption would predict). This was caught by actually screenshotting the
result — a visibly faceted, low-poly "cut gem" silhouette that neither
tuning noise amplitude nor fixing a real bloom-resolution bug (see below)
changed at all, which is what pointed at the geometry itself rather than
the shading. `detail 16` (5,780 triangles) is what was actually verified
to read as smooth at this on-screen size.

**A second real bug caught the same way**: `UnrealBloomPass` was
constructed with a placeholder `Vector2(1, 1)` resolution instead of the
real canvas pixel size. `UnrealBloomPass` builds its internal mip-mapped
blur chain from that resolution, so a `(1,1)` placeholder produced a
broken, blocky glow — which, combined with the low-poly geometry above,
was the other half of the "cut gem" look. Fixed to pass the real initial
canvas size and keep it in sync via `composer.setSize()` on resize.

Surface motion: layered, domain-warped 3D simplex noise (public-domain
Ashima/McEwan GLSL implementation, the same noise family referenced in
the previous build) displaces each vertex along its normal, with the
normal itself recomputed per-vertex from two tangent-offset neighbor
samples (not reused from the undisplaced sphere) so lighting responds to
the real displaced surface.

**Material, reworked 2026-10-27** (the first pass's flat/matte/uniformly-
cyan look was rejected against a real reference image — a liquid-chrome
sphere with several distinct glowing cyan "eyes" spread across its whole
surface, sharp specular, pure-black background — and reworked to actually
match it, see `.verification-screenshots/*-core-material-v2-*.png`):

- **Geometry displacement is now small and low-frequency** (`uAmpBase`
  0.013, far below the first pass's 0.06) — the first pass's large,
  high-frequency bump amplitude made the sphere read as a rough cratered
  rock and scattered the specular highlight into dozens of tiny glints
  instead of one coherent one. The "liquid chrome" look now comes almost
  entirely from fragment-shader shading on a nearly-smooth sphere, the
  same way a bump/normal map reads as liquid metal without needing actual
  heavy geometry.
- **Base color is silver/chrome/titanium, not cyan** — `uColorDeep`/
  `uColorMid` are a dark steel shadow and a bright silver, modulated by a
  "brushed liquid metal" grain (two layered, differently-scaled `fbm`
  samples turned into thin sine-wave contour bands via `pow(...ingredient, 7.0)`,
  so lines meander like poured liquid instead of running parallel) and a
  Lambert diffuse term from a mostly-overhead, slowly-orbiting key light.
- **A real Blinn-Phong specular highlight** (tight `pow(…, 140.0)` lobe
  plus a wider, fainter secondary lobe, both strengthened at grazing
  angles) is what actually sells "polished metal" — the first pass only
  had a fresnel wash, which read as a soft glow, not a reflective catch-
  the-light highlight.
- **Nine glowing "vortex eyes"** (`vortexEye()`, Fibonacci-sphere placed —
  nine, not the obvious six, because six left as few as two actually
  camera-facing at once, checked against real screenshots; nine reliably
  keeps several in view from any angle) are circular patches with an
  Archimedean spiral ring pattern (`sin(r*13.0 - theta*arms + …)` — radius-
  linear phase, deliberately not a `1/r` twist, which was tried first and
  produced thin chaotic veins instead of a clean whirlpool) plus a bright
  core, each with its own arm count/size/phase/speed so they don't read as
  one shape stamped repeatedly. Their spin speed and brightness reuse the
  existing `uEnergy`/`uAudio` reactivity uniforms (churn faster/brighter
  during real thinking/execution and real speech audio) — no new
  reactivity signals were added, this is the existing ones put to double
  use. The eyes' color is also modulated by the same metal-grain texture
  so the glow reads as the liquid itself lit from within, not a flat
  sticker on top of it.
- `scene.background` is now set explicitly to pure black (`0x000000`)
  rather than relying on the renderer's default — the chrome material and
  bloom only read correctly against a truly black backdrop, per the
  reference image.
- The luminance-based Reinhard tonemap (scaling all three channels by one
  factor derived from luminance, not compressing each channel
  independently) is unchanged from the first pass and still does its job:
  a bright `ERROR`/high-energy moment keeps its warm tint instead of
  blowing out to flat white, which an earlier per-channel version of the
  same tonemap was measurably doing.

Five effects total, deliberately few per the brief's own guidance to
prefer a small number of effects that read clearly together over many
stacked mediocre ones: the core shader itself, a soft additive halo
sprite, a sparse background dust layer (depth cue only, never the primary
silhouette), real `UnrealBloomPass` post-processing, and a small
energy-driven camera micro-shake. No orbit rings, no wireframe grid, no
particle cloud as the primary shape — all three are the previous build's
explicitly rejected techniques.

State → visual profile mapping (`STATE_PROFILES` in `core.js`) and the
idle "breathing" (a frequency-modulated double sine, so it never
obviously loops) are tuned by hand against real screenshots, not derived
from a formula.

## Reused from the previous build, deliberately

- `icons/icon-192.png` / `icons/icon-512.png` — an abstract teal-to-amber
  radial gradient, not tied to the old wireframe aesthetic, still fits.
- `manifest.json` — unchanged; its PWA contract (`start_url`/`scope`
  `/hologram`, same icons) still matches this build.

Everything else (the old `index.html`, and the webcam face-tracking
feature under the old build's `facetrack/`) was deliberately **not**
carried forward — face tracking wasn't part of this rebuild's brief
(conversation, activity, current task, and real controls were; a webcam
feature wasn't asked for), so it was dropped rather than ported, saving
~1.6MB of vendored model weights this build doesn't use.

## Verification

Headless Playwright (Chromium, software `swiftshader` rendering — no real
GPU in this sandbox) against a tiny fake-Core `Bun.serve` script standing
in for `/status`, `/observer`, and `/chat`, the same pattern the previous
build's own verification used:

- Real screenshots at an iMac-representative desktop width (1600×1000), a
  laptop width (1440×900), and iPhone portrait (390×844) — idle state.
- A simulated real task (`jarvis.liveState.changed` IDLE→THINKING→
  EXECUTING→SPEAKING→IDLE plus real `tool.requested`/`tool.executed`
  events) — confirmed the Core visibly brightens/grows during execution,
  the activity log and current-task line update from the real event
  payloads, and the chat bubble shows the real reply text.
- A simulated real tool failure — confirmed the warm "needs attention"
  tint is visible and distinguishable, not a washed-out white blowout
  (this is what caught the tonemap bug above).
- `prefers-reduced-motion: reduce` — confirmed continuous idle
  rotation/breathing/camera drift stop, the page still renders a stable,
  legible frame, and real-signal reactivity is unaffected.
- The mobile status sheet (system panel as a bottom sheet on phone width).
- Voice Mode toggle on/off against Playwright's fake media device —
  confirmed no runtime errors through `getUserMedia` → `AudioContext` →
  `SpeechRecognition` → cleanup, and that enabling it auto-enables the
  speaker toggle and disabling it fully tears both down.
- Zero page/console errors across every one of the above.

Screenshots are saved under `.verification-screenshots/` in this
directory.

**Not verified here** (said plainly, not glossed over): real GPU
performance (this sandbox has no GPU — a measured FPS number from
software rendering wouldn't mean anything about a real iMac/iPhone GPU,
unlike the previous build's own comparable disclaimer), real speech
recognition accuracy, real iOS Safari's actual restart timing/latency
between utterances, and real device microphone/speaker behavior. These
need a real device, the same honest gap the previous build's face-tracking
section and the rest of this project's Swift-agent work already
consistently flag.

## Known limitations

- No wake-word gate (see "Voice Mode" above) — a simple text-contains
  filter stands in for one.
- No image attachment in the chat composer (the real `/chat` protocol
  supports it — see `isValidWebChatImage` in
  `JarvisWebSocketServer.ts` — this page just doesn't expose a control for
  it yet).
- No automated visual-regression testing — verification is a manual
  render-and-look pass, same as the previous build.
- The CONFIRM/DANGEROUS tool-call confirmation prompt has explicit
  Confirm/Cancel buttons; a spoken "yes"/"no" (or "כן"/"לא") while one is
  pending also works, for free, through the same continuous-listening →
  `/chat` pipeline every other utterance uses — no separate voice handling
  was needed for it.
