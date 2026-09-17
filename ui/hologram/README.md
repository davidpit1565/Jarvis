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

## Wiring it to real Core state (not done yet)

Right now the two side panels (`SYSTEM STATUS`, `DEVICE LINK`) show
placeholder numbers that jitter on a timer, purely for visual life. To make
them real, connect this page to JARVIS Core's WebSocket server
(`src/communication/websocket/JarvisWebSocketServer.ts`) and replace the
`leftLines`/`rightLines` data in the `<script>` block with live values —
device connection state, active tool count, permission-gate status, etc.
The glitch/banner effect is purely decorative and isn't tied to any real
system event; wiring it to an actual alert condition (e.g. a permission
denial or a device disconnect) instead of a random timer would make it
mean something rather than just look interesting.

## Known limitations

- This is a visual mockup, not a production HUD — there's no accessibility
  handling (screen readers, reduced-motion) and no mobile/touch layout.
- Rendering ~15,000 additive-blended particles is comfortable on a modern
  GPU but untested on low-power hardware; drop the particle target in
  `sampleParticles(mask, MASK_SIZE, 15000)` if it stutters.
