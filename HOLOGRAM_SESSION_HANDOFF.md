# Hologram / Core UI session — handoff notes

Written at the end of a long session focused on `ui/hologram/index.html` (the
"Core" visual HUD) and getting it live on a real device. Meant as context for
whoever (human or Claude session) picks this up next — paste this whole file
into a fresh session as the first message if you want full context fast.

## What this session actually built

1. **Core VFX, two rounds** (`ui/hologram/index.html`, `ui/hologram/README.md`
   has full technical writeups):
   - Round 1 — "digital brain, not a globe/planet": organic (noise-displaced,
     not lat/long-grid) inner mind shell, free multi-axis idle tumble instead
     of a Y-axis-only sway, outer-body growth tied to real thinking activity,
     a third blob-silhouette noise octave.
   - Round 2 — 10 more passes: depth-fog particle tinting, traveling
     energy-pulse orbit rings, neural/tendril firing flashes, real-event
     shockwave bursts, state-tied halo color, a moving specular glint, camera
     micro-shake, a 3D depth-dust layer, an extra ring wobble axis,
     frequency-modulated "heartbeat" breathing.
   - **Open user feedback, not yet done**: the orbit rings and growth/motion
     speed still read as "too fast" / "not quality" / "not like a
     professional Jarvis" — next design pass should tone this down (fewer or
     slower rings, calmer growth pacing) rather than add more effects.

2. **Serving the hologram UI from Core itself** — it used to only work as a
   local `file://` open or a throwaway `python3 -m http.server`. Core's own
   HTTP server (`JarvisWebSocketServer.ts`) now serves the whole
   `ui/hologram/` directory at `/hologram/` (note the trailing slash — see
   the bug note below), gated by the same WebAuthn lock as `/`. Added a PWA
   manifest + generated icon + apple-mobile-web-app meta tags so "Add to Home
   Screen" on a phone behaves like a real app. `coreOrigin()` in the client
   JS auto-picks `ws`/`wss` and `http`/`https` based on `location.protocol`,
   scoped specifically to the `/hologram` path so the documented local-dev
   flow (`python3 -m http.server` at an arbitrary port) isn't broken.

3. **Real two-way chat**, `ws(s)://.../chat` — the hologram page previously
   only ever showed/reacted to JARVIS, no way to talk to it. New WebSocket
   route routes messages through the same `orchestrator.handleUserMessage()`
   the CLI loop and phone gateway use (`webChatOrchestrator` dependency on
   `JarvisWebSocketServer`, wired in `src/index.ts`). Gated by
   `JARVIS_ADMIN_TOKEN` via `?token=` query param when one is configured. A
   toggled full-screen chat overlay in the UI (💬 TALK TO JARVIS button),
   token prompted once and cached in `localStorage` under
   `jarvis_admin_token`.

4. **Hands-free voice mode** — a 🎙️ VOICE MODE toggle inside the chat panel:
   `SpeechRecognition` transcribes speech and sends it as a chat message,
   the real reply is read back via `SpeechSynthesis`, then listening resumes
   automatically. Only shown when the browser actually supports
   `SpeechRecognition` (Chrome desktop; **not** Safari/iOS — Apple ships no
   implementation, a real platform gap, not a bug here).

## Deployment — Fly.io

- App: `jarvis-6b5jhg` (region `ams`), public URL
  `https://jarvis-6b5jhg.fly.dev`. Launched via Fly's "Launch from GitHub"
  web wizard, not `fly launch` — this matters because it did **not**
  auto-allocate a public IP (had to run `flyctl ips allocate-v4 --shared` +
  `allocate-v6` by hand the first time; if a *new* Fly app is ever created
  the same way, check `flyctl ips list` isn't empty before debugging DNS).
- A GitHub Actions workflow (`.github/workflows/fly-deploy.yml`, added by
  the parallel session — see below) now auto-deploys on push to `main`. You
  generally do **not** need to click anything in the Fly dashboard anymore;
  push to `main` and wait ~1-2 min.
- **Real bug already found and fixed** (by the parallel session, PR #13):
  `/hologram` (no trailing slash) must **302 redirect** to `/hologram/` —
  otherwise the page's relative asset paths (`./three.min.js` etc.) resolve
  against `/` instead of `/hologram/`, 404 into the WS-endpoint catch-all
  text response, wrong MIME type, and the browser silently refuses to
  execute them (looks exactly like "the Core doesn't render, no console
  errors visible unless you check Network"). Always link people to
  `/hologram/` with the trailing slash to avoid relying on the redirect.
- Secrets currently set (names only, not values — check
  `flyctl secrets list -a jarvis-6b5jhg`): `ANTHROPIC_API_KEY`,
  `JARVIS_ADMIN_TOKEN`, `TWILIO_AUTH_TOKEN`, `TWILIO_PUBLIC_BASE_URL`,
  `JARVIS_WEATHER_LATITUDE`/`JARVIS_WEATHER_LONGITUDE` (set to Antwerp,
  51.2194/4.4025 — user is based there, static config, not live-location —
  the weather tool has no per-query location parameter today). Also present
  but **not from this session**: `JARVIS_STUDIO_BASE_URL`,
  `JARVIS_STUDIO_SECRET` — unexplained, ask the user or check the parallel
  session's work before touching them.
- **`JARVIS_ADMIN_TOKEN` was rotated mid-session by the parallel session**
  without coordination — if `/chat` or pairing-approve suddenly 401s with a
  token that worked before, that's almost certainly why. Get the current
  value via `flyctl ssh console -a jarvis-6b5jhg -C "bun -e 'console.log(process.env.JARVIS_ADMIN_TOKEN)'"`
  (needs a Fly API token — ask the user for one from
  fly.io/user/personal_access_tokens if you don't have shell access to a
  session that already authenticated `flyctl`).
- **flyctl deploy from a sandboxed/proxied environment will likely fail**:
  Fly's remote "depot" builder uses gRPC over HTTP/2, which this kind of
  environment's egress proxy explicitly does not support (TLS cert errors,
  `deadline_exceeded`). `flyctl secrets set` (no `--stage`) works fine
  though — it does a rolling machine update with the existing image, no
  build needed, so it's the reliable way to push env/secret changes without
  a full rebuild. For an actual code change, push to `main` and let the
  GitHub Actions workflow build it instead of trying `flyctl deploy`
  locally.
- Device pairing (the macOS `JarvisAgent`) is now persisted in SQLite
  (parallel session's work, `DeviceRegistry.ts`) — should survive Core
  restarts going forward, unlike earlier in this session where every
  redeploy silently wiped the in-memory registry and required re-approving
  the Mac's pairing code by hand (`POST /pairing/approve` with
  `X-Jarvis-Admin-Token`).

## A second, independent session was working on this repo concurrently

Mid-session, ~213 files / ~18k lines landed on `main` (PR #5,
"reminders, real internet reading, and reliability hardening") that this
session did not write: Gmail, Google Calendar, Spotify, Telegram, weather,
news/RSS, wake-up calls, reminders, conversation-history search, an
"undo last action" tool, an emergency lockdown mode, device-registry
SQLite persistence, a rate limiter, and a bunch of new device tools
(list/quit running applications, list directory, read text file). None of
that was verified by this session — most of it needs real OAuth
app registration (Google Cloud Console for Gmail+Calendar, a Spotify
developer app) or account setup (Telegram BotFather) before it does
anything. **Check with the user whether that other session is still active
before making further changes to shared files** (especially
`src/index.ts`, `src/config/index.ts`, `JarvisWebSocketServer.ts`) to avoid
clobbering each other — this session already had one scare where a 302
redirect fix, a device-registry rewrite, and an admin-token rotation all
landed without warning mid-debugging-session.

## Known gaps / honest TODOs

- Only `GET_ACTIVE_APPLICATION` has been confirmed working end-to-end
  against the user's real Mac. The other device tools (open URL/app,
  compose email draft, click element, type text, quit application, list
  running apps, list directory, read text file) exist in code but are
  unverified in practice.
- No `launchd` auto-start confirmed on the user's Mac — closing Terminal or
  rebooting stops `JarvisAgent` until it's run again by hand
  (`agents/imac/JarvisAgent/Resources/com.jarvis.agent.plist` exists but
  installing/loading it was never verified this session).
- Twilio phone gateway is wired and `phoneGatewayEnabled: true`, but the
  user deliberately deprioritized it (Twilio wants a paid/verified account
  to actually receive calls) — phone number webhook was never actually
  configured to point at `/voice/incoming`.
- A native "Hey Jarvis" wake word is apparently in progress on the macOS
  agent side (`agents/imac/JarvisAgent/Sources/JarvisAgent/Voice/WakeWordListener.swift`,
  parallel session) — status/completeness unknown, not touched by this
  session.
- Orbit-ring/growth visual pacing feedback (see item 1 above) still open.
- Gmail/Calendar/Spotify/Telegram integrations need real OAuth app
  registrations the user hasn't started yet as of this handoff.
