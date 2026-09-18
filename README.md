# JARVIS

JARVIS is a personal AI assistant project. The long-term vision connects an
iMac, an iPhone, and a MacBook into one system where Claude reasons about
what to do, and JARVIS executes actions on the user's behalf — with
persistent memory, permissioned tool access, and voice interaction, in
both Hebrew and English.

This repository is still early in that vision.

## Primary device model

The user's **iMac is the primary/main computer**. Device rollout order:

1. **iMac — primary computer** (Phase 2, in progress: architecture and Core
   support exist; the real Swift agent is unbuilt/unvalidated)
2. **iPhone — mobile client** (not started)
3. **MacBook — secondary computer** (not started)

"Primary" is a Core-side data/policy distinction, not special-cased code:
a `Device.role` field (`"primary" | "secondary" | "mobile"`) is assigned by
Core only after a human approves a device's pairing — a device can
*request* a role (e.g. the iMac Agent requests `"primary"`) but can never
assign one to itself. Exactly one device may hold `"primary"` at a time.
Tool calls that don't name an explicit target device route to whichever
device is currently primary.

**The iMac is an execution/context device, not a second brain.** Claude
lives only in JARVIS Core; the iMac Agent has no path to call Claude
directly and never decides what should happen — it only executes tools
Core has already approved.

## Phase 1 scope (complete)

Proves the core loop end to end in a single local process:

```
USER → JARVIS → CLAUDE → TOOL DECISION → PERMISSION CHECK
     → TOOL EXECUTION → TOOL RESULT → CLAUDE → RESPONSE
```

## Phase 2 scope (this phase)

Extends the loop so a tool can execute on a **real device** instead of only
locally in Core:

```
USER → JARVIS CORE → CLAUDE → ORCHESTRATOR → PERMISSION SERVICE
     → TOOL REGISTRY → DEVICE REGISTRY → DEVICE CONNECTION MANAGER
     → WebSocket tool.request → iMac AGENT → explicit tool → tool.result
     → back through Core → CLAUDE → RESPONSE
```

What's new in Phase 2:

- Device model extended with `role`, `agentVersion`, `protocolVersion`
  (`src/types/devices.ts`), and `DeviceRegistry.setRole()` /
  `getPrimaryDevice()`.
- A typed, versioned WebSocket **envelope protocol**
  (`src/communication/websocket/protocol.ts`) replacing Phase 1's
  placeholder message shapes — every message carries `requestId`,
  `timestamp`, `deviceId` (null only for a device's very first
  `device.register`), `type`, and a validated `payload`.
- **Pairing/authentication** (`src/devices/pairing/PairingService.ts`):
  first connection requires a human-approved pairing code; approval mints
  a long-lived credential whose hash (never the plaintext) Core retains.
- **Device-scoped permissions**: a grant is now `(userId, toolId, deviceId)`
  — granting a tool on the iMac never authorizes it on a future MacBook.
- **Remote tool execution**: tools now declare `target: "local"` or
  `target: "device"`. The `Orchestrator` resolves a target device (explicit
  `deviceId` input, or the primary device), and a new
  `DeviceConnectionManager` owns the WebSocket request/response lifecycle
  (unique request IDs, timeouts, cleanup on disconnect) so the Orchestrator
  never touches a raw socket.
- **First device tool**: `GET_ACTIVE_APPLICATION` — read-only, reports the
  frontmost application's name and bundle ID on the target device.
- **Bilingual (Hebrew + English) conversation**: a fixed system instruction
  (`src/core/brain/systemPrompt.ts`) tells Claude to detect and respond in
  the user's language, including mixed Hebrew/English in one message. Tool
  IDs, protocol types, and all technical identifiers stay English-only —
  only the conversational layer is bilingual.
- **iMac Agent** (`agents/imac/JarvisAgent/`): Swift source for the macOS
  agent — **now built and run on a real iMac**, completing a live
  `device.register` → pairing → credential-in-Keychain flow against a real
  Core instance (see below for exactly what is and isn't verified yet).

**Explicitly out of scope for Phase 2** (not implemented, not stubbed as
real functionality):

- iPhone client, MacBook agent
- Full voice input/output (microphone-based speech-to-text / text-to-speech
  — the phone channel below uses Twilio's own speech recognition/synthesis
  instead, so this remains open for any non-phone voice channel)
- Browser automation
- Arbitrary shell/AppleScript execution, sudo, process injection
- Unrestricted keyboard/mouse/application automation
- Any destructive filesystem operation
- Persistent (disk-backed) device registry, permission grants, or pairing
  store — all in-memory, matching Phase 1's pattern
- Continuous/high-frequency context monitoring (e.g. streaming
  `active_window.changed` events)

## Persistent memory

Beyond the in-memory conversation state, JARVIS has an explicit, SQLite-backed
memory store (`src/memory/MemoryStore.ts`) that survives restarts:

- **`SAVE_MEMORY`** (`src/tools/memory/SaveMemoryTool.ts`) — `SAFE_ACTION`
  level, standing-granted to the local user at startup (single-user
  assistant, not multi-tenant). Saves a `{key, value}` fact Claude decides
  is worth remembering.
- **`SEARCH_MEMORY`** (`src/tools/memory/SearchMemoryTool.ts`) — `READ`
  level. Lets Claude recall previously saved facts by a text fragment
  before answering.

This is the first real step toward "JARVIS knows things about you between
conversations" rather than only within a single session.

## Reminders / tasks

A separate SQLite-backed store (`src/reminders/ReminderStore.ts`,
`JARVIS_REMINDERS_DB_PATH`) for things to *do*, not facts to recall — a
reminder has a lifecycle (pending, then completed), a memory doesn't:

- **`CREATE_REMINDER`** (`SAFE_ACTION`, standing-granted) — creates a
  reminder/task, optionally with an ISO 8601 `dueAt` Claude resolves from
  whatever the user actually said ("remind me at 6pm").
- **`LIST_REMINDERS`** (`READ`) — pending reminders by default, soonest-due
  first (undated ones last); pass `includeCompleted` to see everything.
- **`COMPLETE_REMINDER`** (`SAFE_ACTION`, standing-granted) — marks one
  done by id.

## Conversation history search

Every user/assistant text turn (tool calls/results are excluded — protocol
noise, not something worth searching for) is durably logged to SQLite
(`src/history/ConversationHistoryStore.ts`, `JARVIS_CONVERSATION_HISTORY_DB_PATH`)
via the existing `conversation.message` event, across every conversation
JARVIS has ever had — the terminal chat and every phone call alike, since
they all share one `EventBus`. **`SEARCH_CONVERSATION_HISTORY`** (`READ`)
lets Claude answer "what did we talk about" / "did I already tell you..."
with an actual case-insensitive substring search over that transcript,
instead of only seeing the current thread. Distinct from `SEARCH_MEMORY`
(explicit facts Claude chose to save) and reminders (tasks) — this is the
raw record of what was actually said.

## Confirmation flow for CONFIRM / DANGEROUS tools

`CONFIRM` and `DANGEROUS` tools now have a real approval path instead of
being unconditionally denied:

- A standing `PermissionService` grant for one of these tools means "the
  user has opted in to being asked" — it is never treated as "skip
  asking." The actual gate is a fresh `ConfirmationService.requestConfirmation()`
  call on **every single invocation**, no exceptions.
- `src/core/confirmation/ConfirmationService.ts` defines the gate as a
  small `ConfirmationPrompter` function (`(request) => Promise<boolean>`),
  decoupled from any particular UI. Today's only prompter asks in the
  terminal chat (`confirmViaChat` in `src/index.ts`); a future channel
  (push notification, a spoken yes/no over the phone gateway below) is
  just a different prompter passed to the same `ConfirmationService` — no
  change needed in the `Orchestrator`.
- The `Orchestrator` calls this gate from one shared `authorize()` method
  used by both local and device tool execution, so the policy can't drift
  between the two paths.

## Architecture

```
src/
├── core/
│   ├── conversation/   ConversationManager — in-memory turn state
│   ├── brain/          ClaudeBrain — talks to Anthropic, never executes tools
│   │                   systemPrompt.ts — bilingual (Hebrew/English) instruction
│   ├── events/         EventBus — typed pub/sub for orchestration events
│   └── orchestrator/   Orchestrator — routes tool calls to local execute()
│                       or to a device via DeviceConnectionManager
├── tools/
│   ├── registry/       ToolRegistry — allowlist of tools Claude may call
│   ├── filesystem/     READ_ONLY_FILE_INFO — local tool
│   ├── system/         GET_ACTIVE_APPLICATION — device tool (iMac first)
│   └── memory/         SAVE_MEMORY / SEARCH_MEMORY — local, persistent memory tools
├── permissions/         PermissionService — (userId, toolId, deviceId) grants
├── memory/              MemoryStore — SQLite-backed explicit key/value store
├── devices/
│   ├── registry/        DeviceRegistry — device metadata + role assignment
│   └── pairing/         PairingService — pairing codes, credential hashes
├── communication/
│   ├── websocket/
│   │   ├── protocol.ts               Typed, validated envelope protocol
│   │   ├── DeviceConnectionManager.ts  Owns connections + tool request/response lifecycle
│   │   ├── JarvisWebSocketServer.ts    Thin transport: bytes <-> validated messages,
│   │   │                                plus routing for the /voice/* webhooks below,
│   │   │                                the GET / /status status dashboard, and the
│   │   │                                audio-stream ingest/broadcast routes below
│   │   ├── dashboard.ts                Self-contained HTML for the live status page
│   │   └── AudioLevelBroadcaster.ts    Fans out live call audio levels to dashboard viewers
│   └── phone/
│       ├── TwilioVoiceGateway.ts   Per-call session + TwiML generation
│       ├── twilioSignature.ts      Twilio webhook signature verification
│       └── audioLevel.ts           µ-law decode + RMS amplitude for the waveform
├── core/confirmation/   ConfirmationService — pluggable per-call approval gate
│                        for CONFIRM/DANGEROUS tools
├── auth/
│   ├── WebAuthnStore.ts     Registered Face ID/Touch ID credentials (SQLite)
│   ├── WebAuthnService.ts   Registration/authentication ceremonies
│   └── SessionStore.ts      In-memory dashboard session tokens
├── config/              Environment variable loading and validation
└── types/               Shared TypeScript types across all modules (incl.
                         voice.ts — provider-agnostic STT/TTS interfaces,
                         architecture only, not yet wired to an implementation)

agents/
└── imac/JarvisAgent/    Swift source for the macOS iMac Agent (unbuilt —
                         see "Linux vs. macOS validation" below)
```

Design principles carried through every module:

- **Claude reasons, JARVIS executes.** `ClaudeBrain` only returns text and
  requested tool calls. The `Orchestrator` is the sole place that decides
  whether a tool runs, and whether it runs locally or on a device.
- **Every tool requires an explicit permission level** (`READ`,
  `SAFE_ACTION`, `CONFIRM`, `DANGEROUS`), checked before execution — scoped
  per device for device tools.
- **Tools are allowlisted** in two independent places: Core's
  `ToolRegistry`, and (for device tools) the Agent's own compiled-in tool
  table. Core approval alone is never sufficient — the device must also
  recognize and be willing to run the tool.
- **The Core does not assume macOS.** Device-specific behavior lives only
  in a device agent, never in Core.
- **No secrets in git.** Configuration is loaded from environment
  variables and validated at startup; `.env` is git-ignored. Device
  credentials are hashed in Core and stored in the Keychain on the device.

## Requirements

- [Bun](https://bun.sh) (developed against 1.3.x)
- An Anthropic API key
- For the iMac Agent only: a real Mac with Xcode — **not available or
  used in this development environment**

## Install

```bash
bun install
```

## Configure

```bash
cp .env.example .env
```

Then set `ANTHROPIC_API_KEY` in `.env`. Optional variables:

- `JARVIS_PORT` — port for the HTTP/WebSocket server (default `4770`)
- `JARVIS_MEMORY_DB_PATH` — path to the local SQLite memory database
  (default `./data/jarvis-memory.sqlite`)
- `TWILIO_AUTH_TOKEN` / `TWILIO_PUBLIC_BASE_URL` — enable the phone-call
  channel (see below). **Both or neither** — setting only one throws a
  `ConfigError` at startup, since request-signature verification needs
  both to be meaningful.
- `JARVIS_ADMIN_TOKEN` — **required** once the two Twilio variables above
  are set (also a `ConfigError` if missing then); optional otherwise. See
  "Security controls" below for why.
- `JARVIS_WEB_SEARCH` — set to `true` to give JARVIS real internet search
  (see below). Off by default.
- `JARVIS_WEB_SEARCH_MAX_USES` — caps searches per turn (default `5`).
- `JARVIS_AUDIO_WAVEFORM` — set to `true` for a live audio waveform on the
  dashboard during phone calls (see below). Off by default — **this has a
  real extra cost** (~$0.004/min via Twilio Media Streams).

## Real internet search

JARVIS previously had no way to search the internet at all — only
`READ_ONLY_FILE_INFO`, `GET_ACTIVE_APPLICATION`, `SAVE_MEMORY`, and
`SEARCH_MEMORY` existed. Setting `JARVIS_WEB_SEARCH=true` enables
Anthropic's own server-side `web_search` tool
(`src/core/brain/ClaudeBrain.ts`) — real search that runs entirely on
Anthropic's infrastructure and is billed through the same
`ANTHROPIC_API_KEY`, with **no separate vendor, account, or API key**.

- This isn't a tool JARVIS's own `Orchestrator`/`ToolRegistry` executes —
  it's resolved server-side inside a single Anthropic API call, so it
  needed no changes to the tool-execution loop at all, only to how
  `ClaudeBrain` builds its request and reads the response.
- The dashboard's live ticker (see "Status dashboard" below) shows
  "Searching the web…" when a search actually happens, detected from the
  real `server_tool_use` content block Anthropic returns — not simulated.
- `JARVIS_WEB_SEARCH_MAX_USES` caps how many searches Claude may run in
  one turn (default 5), since each search has its own cost.
- **Known limitation**: when a later turn's conversation history is
  replayed to Claude, only the final synthesized text response is
  preserved — the raw search results/queries themselves aren't currently
  stored and replayed. The substance of what was found is retained in the
  text; the raw search trace is not.
- **Not yet verified against the real Anthropic API** — the request/response
  shaping logic is unit-tested (`tests/brain/ClaudeBrain.test.ts`), but no
  real API key was available in this environment to confirm an actual
  search executes end to end.

## Real URL reading (web_fetch)

`JARVIS_WEB_FETCH=true` enables Anthropic's own server-side `web_fetch`
tool, alongside (not instead of) `web_search` above — same account/billing,
same "no separate vendor" reasoning. The difference: `web_search` finds
pages and returns snippets; `web_fetch` actually opens and reads a
specific URL's content, so JARVIS can answer questions about a page you
give it directly, or read the full page behind a search result rather than
guessing from the snippet alone. `JARVIS_WEB_FETCH_MAX_USES` caps how many
fetches Claude may run in one turn (default 5). Same "not yet verified
against the real Anthropic API" caveat as `web_search` applies here too.

## Run

### The easy way (one command, on the iMac)

```bash
bash scripts/start-everything.sh
```

This starts Core, builds the Agent if it isn't built yet, starts it,
detects its pairing code automatically, approves it automatically, and
hands you straight into the interactive chat — no other terminal windows,
no manual copy/pasting of IDs or codes. Requires `ANTHROPIC_API_KEY` to
already be set in `.env` (the script tells you how if it isn't).

### The manual way

```bash
bun run dev
```

On startup this registers `READ_ONLY_FILE_INFO` and `GET_ACTIVE_APPLICATION`,
opens the local memory database, and starts the WebSocket server. A real
device can connect and run through the `device.register` → pairing →
`tool.request`/`tool.result` flow — **verified against the real iMac Agent**
(see `agents/imac/JarvisAgent/`, which now builds and runs on macOS).

### Approving a device's pairing code

When a device registers for the first time, Core logs a 6-digit pairing
code (also printed directly by the Agent, if it's the one connecting).
Approve it with:

```bash
bun run approve-device <deviceId> <code>
```

This calls Core's `POST /pairing/approve` endpoint, which mints the
device's long-lived credential and — if the device's socket is still open
— pushes the credential to it immediately, promoting the connection to
authenticated in the same step.

## Phone gateway (call JARVIS)

JARVIS can be reached as an actual phone call, via
[Twilio](https://www.twilio.com) Programmable Voice — answering "can I make
JARVIS a contact I call" without building a separate STT/TTS pipeline:
Twilio's own `<Gather input="speech">` does speech-to-text and `<Say>` does
text-to-speech, so the gateway (`src/communication/phone/TwilioVoiceGateway.ts`)
only needs to shuttle text in and out through the existing `Orchestrator`.

**How it works:**
- Each call gets its own `ConversationManager` + `Orchestrator` pair (a
  fresh conversation thread) but shares every other live instance — same
  Claude brain, same tools, same memory, same permission/confirmation
  state as the terminal chat.
- Three webhook routes, added to the existing WebSocket server's HTTP
  handling (`src/communication/websocket/JarvisWebSocketServer.ts`):
  `POST /voice/incoming`, `POST /voice/gather`, `POST /voice/status`.
- Every incoming webhook request's Twilio signature is verified
  (`src/communication/phone/twilioSignature.ts`, HMAC-SHA1 per Twilio's
  spec) against the **configured public URL**
  (`TWILIO_PUBLIC_BASE_URL`), not the server's own view of the request
  URL — required because a tunnel (ngrok) or reverse proxy rewrites what
  the process sees. A missing or invalid signature is rejected with
  `403` before anything reaches the Orchestrator.

**To actually go live, you need your own Twilio account** (same
requirement as needing your own Anthropic API key — this repo never
ships credentials for either):
1. Create a Twilio account and buy a phone number with Voice capability.
2. Run JARVIS somewhere Twilio's servers can reach over HTTPS — see
   "Cloud deployment" below for the recommended way (an always-on host,
   no dependency on a personal machine staying on), or tunnel a local
   machine with something like ngrok for quick testing.
3. Set `TWILIO_AUTH_TOKEN` (from the Twilio console) and
   `TWILIO_PUBLIC_BASE_URL` (the public HTTPS URL Twilio will hit) as
   environment variables/secrets on wherever JARVIS runs.
4. In the Twilio console, set the phone number's "A call comes in"
   webhook to `<TWILIO_PUBLIC_BASE_URL>/voice/incoming` (HTTP POST).
5. Optionally set `TWILIO_ALLOWED_CALLERS` to a comma-separated allowlist
   of E.164 numbers (see "Security controls" above) — recommended before
   giving the number out.
6. Optionally set `TWILIO_VOICE` to pick a different English `<Say>` voice.
   The default, `Polly.Matthew-Neural`, is a natural-sounding neural voice
   available on standard Twilio accounts (no beta opt-in) — a clear
   step up from Twilio's robotic default "Basic" voice. If the account
   has Twilio's newer Generative voices enabled (e.g.
   `Google.en-US-Chirp3-HD-Charon`), that's an even more natural option;
   see [Twilio's voice list](https://www.twilio.com/docs/voice/twiml/say/text-speech).
7. Call the number and speak in Hebrew or English (see "Hebrew + English on
   phone calls" below) — JARVIS answers, listens, replies, and keeps
   listening until the call ends.

### Hebrew + English on phone calls

Phone calls get the same bilingual JARVIS as everywhere else, but getting
there needs more than the brain understanding both languages — Twilio's own
speech-to-text and text-to-speech have to be told which language(s) to use:

- **Speech recognition**: `<Gather>` requests `language="multi"` with
  Twilio's `deepgram_nova-3` speech model — Twilio's own real automatic
  Hebrew/English detection in a single request (confirmed against Twilio's
  docs, not guessed). **Requires real validation**: never exercised against
  a live Twilio account, and `deepgram_nova-3` could in principle not be
  enabled on every account. If a call can't be recognized, set
  `TWILIO_GATHER_LANGUAGE` to a single BCP-47 code (`he-IL` or `en-US`) to
  fall back to Twilio's older single-language recognition — you'll lose
  automatic language switching, but the call itself still works.
- **Speech synthesis**: each `<Say>` picks its voice based on whether the
  text being spoken contains Hebrew characters — JARVIS's own canned
  prompts (greeting, "I didn't catch that", errors) are always spoken in
  *both* languages back to back, since the caller's language isn't known
  yet; the brain's actual replies are spoken in just the one language they
  were written in. Amazon Polly (the default English voice) has no Hebrew
  voice at all, so Hebrew always goes through Twilio's Google TTS
  integration (`Google.he-IL-Wavenet-D` by default, overridable via
  `TWILIO_VOICE_HEBREW`).

If `TWILIO_AUTH_TOKEN`/`TWILIO_PUBLIC_BASE_URL` aren't set, the `/voice/*`
routes don't exist at all (`404`) and nothing else changes — the phone
gateway is fully optional.

### Cloud deployment

To make JARVIS reachable by Twilio without keeping a personal machine on
and connected, this repo includes a `Dockerfile` and a `fly.toml` for
[Fly.io](https://fly.io) — a straightforward host for a small always-on
service with a free HTTPS URL. The full one-time setup is documented as
comments at the top of `fly.toml`: `fly launch --no-deploy`, create a
volume for the persistent memory database, set secrets
(`ANTHROPIC_API_KEY`, `TWILIO_AUTH_TOKEN`, then `TWILIO_PUBLIC_BASE_URL`
once the app's URL is known), `fly deploy`, then point the Twilio number
at `<app>.fly.dev/voice/incoming`. Any other Docker-friendly host (Railway,
Render, a VPS) works the same way using the same `Dockerfile` — `fly.toml`
is just the one this repo ships a ready config for.

**Not yet verified**: the `Dockerfile` was written and reviewed but not
built or run in this environment (no Docker daemon available here). Build
it yourself once (`docker build -t jarvis-core .`) before relying on it,
and report back if anything doesn't come up clean.

**What's validated vs. not:** the gateway logic (TwiML generation
including the `voice` attribute, session lifecycle per `CallSid`,
signature verification, the caller allowlist, HTTP routing including
signed/unsigned/tampered requests) is covered by real tests, including
end-to-end HTTP tests against the actual `Bun.serve` server
(`tests/phone/`). What is **not** validated is an actual phone call
through a real Twilio account — that requires the account/number setup
above, which hasn't been done in this environment. In particular, the
actual sound of `Polly.Matthew-Neural` (or any other voice) hasn't been
heard — only that the TwiML correctly requests it.

## Live audio waveform (see JARVIS's voice on a call)

Setting `JARVIS_AUDIO_WAVEFORM=true` adds a live waveform to the
dashboard's "Phone gateway" section, driven by the actual audio of the
current call — both the caller's voice and JARVIS's own spoken replies.

**How it works:**
- Twilio's [Media Streams](https://www.twilio.com/docs/voice/media-streams)
  feature streams raw call audio (µ-law, 8kHz) to a WebSocket as the call
  happens. When enabled, `TwilioVoiceGateway` includes
  `<Start><Stream url="wss://.../voice/audio-stream" track="both_tracks" /></Start>`
  on the call's initial greeting (call-scoped, so it isn't repeated on
  every turn).
- `JarvisWebSocketServer` accepts that stream at `GET /voice/audio-stream`,
  decodes each µ-law chunk with a standard G.711 decode table
  (`src/communication/phone/audioLevel.ts`), and computes a normalized
  0–1 RMS amplitude — enough for a waveform, not for playback or
  transcription.
- Each amplitude value is broadcast in real time (not via the 1s
  `/status` poll) to any browser connected to `GET /dashboard/audio-ws`,
  via `AudioLevelBroadcaster`. The dashboard renders it as scrolling bars
  that decay to silence between chunks.

**Real extra cost, disclosed up front**: Twilio bills Media Streams at
approximately **$0.004/minute**, on top of normal call minutes — small,
but real, which is why this is off by default and never silently enabled.
Core also prints a startup log line naming the cost when it's turned on.

**Verified end to end** (not just unit-tested in isolation): a real
Chromium instance loaded the dashboard while a script fed genuinely
Twilio-shaped `media` events (correct JSON schema, real µ-law bytes) into
`/voice/audio-stream` over an actual WebSocket connection — the waveform
rendered and reacted correctly, confirmed via screenshot, with the "Phone
gateway" side-panel readout also flipping to `LIVE`. Not yet confirmed
against a real Twilio account/call.

## Status dashboard

Visit `http://localhost:4770/` (or `/dashboard`) in a browser while Core is
running to see a live-updating status page: registered devices and their
online/offline state, registered tools, whether the phone gateway is
enabled, and a rolling activity feed (recent tool executions, device
connects/disconnects, and JARVIS's own thinking/responses — see below) via
`ActivityLog` (`src/core/activity/ActivityLog.ts` — an in-memory ring
buffer of the last 30 events, reset on restart). It's served directly by
the same process — no build step, no extra dependency — and polls a plain
JSON feed at `GET /status` every second. This is the first step toward a
real visual layer; it's read-only today (nothing on the page can trigger
an action).

Uses the user's own reference image directly (`src/communication/websocket/assets/hologram.jpg`,
served at `GET /assets/hologram.jpg`) as the hero visual, styled with a
scanline overlay, vignette, an ambient glow pulse, an occasional glitch
flash, and a stronger glow while JARVIS is actively responding — rather
than trying to procedurally reproduce a photoreal 3D render (not
realistic as real-time browser graphics without a custom 3D asset
pipeline). Flanking the image, live readout panels (device/tool/phone
counts, pulled from real `/status` data) glitch-flash when they actually
change, and a live ticker line beneath the image shows what JARVIS is
doing right now:

- **`JARVIS is thinking…`** while a request is being processed
  (`brain.request`)
- **`Searching the web…`** when JARVIS actually invokes the `web_search`
  server tool (see "Real internet search" above) — only when
  `JARVIS_WEB_SEARCH=true` and a search genuinely happens
- **the actual response text** once it replies (`brain.response`),
  with a brighter glow on the hologram while this is showing
- **`Running <tool>…`** while a tool call is in flight (`tool.requested`)

All of this is wired to the real `EventBus`, not simulated — the ticker
only ever reflects what JARVIS actually does.

Verified in a real browser (headless Chromium) against the actual running
server: the page loads, the live data (including the activity feed and
animations) renders correctly for both empty and populated states, and
there are no console errors. All dynamically-inserted text (device names,
tool names, activity messages) is HTML-escaped before insertion — device
names in particular originate from device agents, which are a less
trusted source than Core's own code.

## Face ID / Touch ID for the dashboard

The dashboard can be locked behind Face ID, Touch ID, or any other
platform passkey, via [WebAuthn](https://webauthn.guide) — the same
browser standard real password managers and "Sign in with..." buttons
use, not a custom biometric integration. No third-party vendor, no
uploaded biometric data: the browser and OS handle the actual
fingerprint/face check, and only prove the result to JARVIS.

**How it works:**
- `src/auth/WebAuthnStore.ts` — SQLite-backed storage for registered
  credentials (`JARVIS_WEBAUTHN_DB_PATH`, one database, any number of
  devices — e.g. a MacBook's Touch ID and an iPhone's Face ID can both be
  registered).
- `src/auth/WebAuthnService.ts` — wraps
  [`@simplewebauthn/server`](https://simplewebauthn.dev/)'s registration
  and authentication ceremonies (the actual cryptographic verification is
  never hand-rolled).
- `src/auth/SessionStore.ts` — in-memory session tokens (12-hour TTL,
  reset on restart) issued after a successful unlock.
- **Setup requires `JARVIS_ADMIN_TOKEN`** (the same secret used for
  device-pairing approval — see "Security controls"): without this, the
  first person to load the dashboard could register their own face as
  "the owner." A "Set up" banner appears on the dashboard until at least
  one credential is registered; clicking it prompts for the admin token,
  then triggers the browser's native Face ID/Touch ID/passkey prompt.
- **Unlocking requires no secret** — once at least one credential exists,
  visiting `/` or `/dashboard` shows a lock screen instead of the
  dashboard; the "Unlock" button triggers the same native prompt, and the
  platform authenticator's response (never the biometric data itself,
  which never leaves the device) is what proves identity.
- No external script/CDN dependency: the browser-side conversions
  `@simplewebauthn/browser` would normally handle are hand-written
  (`src/communication/websocket/dashboard.ts`) to keep the dashboard
  self-contained.

**Verified end to end**, not just unit-tested in isolation: a real
Chromium instance, driven via Playwright, completed the actual
`navigator.credentials.create()`/`.get()` browser ceremony against the
real running server, using Chrome DevTools Protocol's virtual
authenticator (`transport: "internal"`, i.e. standing in for real Face
ID/Touch ID hardware, which this development environment doesn't have)
— registration verified (200), login verified (200), and the dashboard
was confirmed unlocked after reload. This proves the full cryptographic
ceremony genuinely works, not only that the server's own logic is
internally consistent.

**Current limitations:**
- No credential-removal UI yet (only a fresh `JARVIS_WEBAUTHN_DB_PATH` or
  manual SQL clears one).
- Sessions are in-memory only — restarting Core requires unlocking again.
- This protects the dashboard specifically; it does not gate `/status`,
  the WebSocket device protocol, or the phone gateway, which have their
  own separate security models (see "Security controls").

## Test

```bash
bun run typecheck
bun test
```

Tests use a scripted mock `Brain` and mocked device connections; the suite
runs without network access, a real API key, or macOS.

## Hebrew + English support

JARVIS detects the user's language per message and responds in kind,
including messages that mix Hebrew and English (e.g. *"Jarvis, open Chrome
and תחפש לי את האתר של Apple"*). This is owned entirely by the
conversational layer (`ClaudeBrain` + a fixed system prompt) — the
`ToolRegistry`, `DeviceRegistry`, and wire protocol are English-only and
contain no language-detection logic, by design.

## Security controls

- No arbitrary shell execution, AppleScript execution, sudo, process
  injection, or unrestricted keyboard/mouse/application automation —
  anywhere in Core or the Agent source.
- Every capability is an explicitly registered tool with an ID, schema,
  permission level, and (for device tools) a named, compiled-in Agent
  function — never a generic "run this" path.
- Defense in depth for device tools: Core's tool allowlist + Core's
  device-scoped permission check + the Agent's own independent tool
  allowlist, before anything executes.
- Device credentials: a human must approve a pairing code before a device
  is trusted; Core stores only a SHA-256 hash (constant-time compared),
  never the plaintext; the Agent is designed to store its credential only
  in the macOS Keychain, never on disk or in logs.
- `POST /pairing/approve` requires `JARVIS_ADMIN_TOKEN` (via the
  `X-Jarvis-Admin-Token` header, constant-time compared) whenever it's
  configured — **mandatory once the phone gateway is enabled**, because
  at that point this same HTTP server is reachable from the public
  internet. Without an admin token, the pairing code alone is the only
  gate on approval — and that code is handed back to whoever requested
  it over the same socket, so anyone who can open a WebSocket connection
  could register a fake device, read its own pairing code, and
  self-approve it into a trusted device with no human involved. Found
  and fixed during this session's own review, once the new `Dockerfile`/
  `fly.toml` made this endpoint publicly reachable for the first time.
- `POST /pairing/approve` and `POST /auth/login` are rate-limited (10
  attempts per 5 minutes, per client IP — `src/communication/websocket/RateLimiter.ts`):
  every attempt counts against the limit whether it succeeds or fails, so
  a 6-digit pairing code (or repeated WebAuthn verification attempts)
  can't be brute-forced by hammering the endpoint. In-memory and
  per-process, resetting on restart — a deliberate simplicity tradeoff for
  a single-instance personal assistant.
- Device-scoped permission grants: authorizing a tool on one device never
  authorizes it on another.
- `CONFIRM`/`DANGEROUS` tools require a fresh, per-call human confirmation
  even when a standing grant exists — a grant means "ask me," never
  "skip asking."
- Every phone webhook request's Twilio signature is verified against the
  configured public URL before it reaches the Orchestrator; unsigned,
  tampered, or wrong-route requests are rejected with `403`.
- Optional phone caller allowlist (`TWILIO_ALLOWED_CALLERS`): when set, a
  call from any other number is turned away with a spoken message before
  it reaches the Orchestrator — signature verification alone only proves
  the request came from Twilio, not who's on the call.
- Optional Face ID/Touch ID lock for the dashboard (see below): real
  WebAuthn, not a custom biometric integration; registering the first
  credential requires `JARVIS_ADMIN_TOKEN` so setup can't be hijacked.
- The audio waveform's ingest endpoint (`/voice/audio-stream`) only
  exists at all when `JARVIS_AUDIO_WAVEFORM=true`, and — unlike the HTTP
  voice webhooks — is **not** Twilio-signature-verified (a WebSocket
  upgrade carries no such header to check). Anyone who knows the URL
  could open it and send fake audio-shaped messages. This is a low-impact
  gap, not a security hole on the order of the pairing/gather ones: the
  path only ever reduces input to a bare 0–1 amplitude number for a
  cosmetic waveform — it cannot inject text into the Orchestrator or
  trigger any tool call.

## Current limitations

- Only four registry-based tools exist: `READ_ONLY_FILE_INFO` (local),
  `GET_ACTIVE_APPLICATION` (device — app name/bundle ID only),
  `SAVE_MEMORY` and `SEARCH_MEMORY` (local, persistent key/value memory).
  Real internet search exists separately, as Anthropic's own server-side
  `web_search` tool (opt-in via `JARVIS_WEB_SEARCH=true`), not through this
  registry — see "Real internet search" above.
- DeviceRegistry, PermissionService, and PairingService are all in-memory
  and reset on restart. (`MemoryStore` is the one exception — it is
  SQLite-backed and persists across restarts.)
- The phone gateway's caller allowlist (`TWILIO_ALLOWED_CALLERS`) is
  optional and off by default — if you don't set it, anyone who calls the
  configured Twilio number reaches the same JARVIS conversation as the
  terminal chat, with the same tool access (including `SAVE_MEMORY`, with
  no per-call confirmation). Core prints a startup warning when the phone
  gateway is enabled without it, but doesn't refuse to start — set it
  before giving the number to anyone but yourself.
- Pairing approval is a manual CLI step (`bun run approve-device`) — there
  is no web UI for it yet.
- No authentication beyond a placeholder `userId`.
- The iMac Agent's connection/pairing/tool-execution logic has been
  compiled and run against a real Core instance; `NSWorkspace`-backed
  `GET_ACTIVE_APPLICATION` execution itself is not yet confirmed end to end
  from real hardware — see the validation split below.

## Linux vs. macOS validation

Core development happens in a Linux environment with no Xcode, macOS SDK,
Swift macOS runtime, Keychain, `NSWorkspace`, or `launchd` — so the Swift
Agent's source was originally written blind. It has since been built and
run against a real Core instance on the actual target iMac, closing part
of that gap; the rest is tracked explicitly below.

**Validated in the Linux Core environment:**
- TypeScript typechecking (`bun run typecheck`) and the full Core test
  suite (`bun test`, 150+ tests)
- WebSocket envelope protocol: valid/invalid envelopes, every message
  type, malformed payloads, wrong/missing `deviceId`
- `DeviceRegistry`: registration, role assignment, primary-device
  invariants
- `PairingService`: code generation/expiration, approval, credential
  verification (constant-time), revocation
- Device-scoped `PermissionService` checks
- `DeviceConnectionManager` against a mocked `DeviceConnection`: successful
  remote tool execution, timeout, disconnect cleanup, unknown device,
  requestId mismatch protection, malformed results
- Full `Orchestrator` remote-tool lifecycle against a mocked iMac device
  (Core → Orchestrator → PermissionService → DeviceRegistry →
  DeviceConnectionManager → mock device → result → Claude)
- The real `Bun.serve` HTTP + WebSocket server end to end: a mock device
  registers, receives a pairing code, `POST /pairing/approve` approves it,
  and the credential is pushed back over the same open socket
  (`tests/integration/pairingApprovalHttp.test.ts`)

**Validated on a real iMac:**
- `swift build` compiles `agents/imac/JarvisAgent` cleanly
- The compiled Agent connects to a real running Core instance over
  `ws://`, completes `device.register`, receives its pairing code, and
  (after `bun run approve-device`) receives and saves its credential

**Still requires further real-iMac validation:**
- Keychain persistence across Agent restarts (the save path ran; a
  restart-and-reconnect using the stored credential hasn't been confirmed).
  `KeychainStore.swift` was hardened with `kSecUseDataProtectionKeychain`
  and real error logging (via `SecCopyErrorMessageString`) to make the
  next real failure diagnosable, and a likely root cause was identified —
  an ad-hoc/unsigned `swift build` gets a new code-signature hash on every
  rebuild, and macOS Keychain access is scoped by code signature, so a
  credential saved by one build may become unreadable by the next. **This
  is not a confirmed fix** — it can't be verified outside a real Mac in
  this environment — and the real fix likely needs a paid Apple Developer
  ID for stable code signing across rebuilds.
- `NSWorkspace.frontmostApplication` — an actual `GET_ACTIVE_APPLICATION`
  tool call executed end to end from Core through the Agent
- Menu bar UI rendering and permission prompts
- `launchd` load/restart/persistence behavior
- Code signing/notarization

## Planned future phases

1. iPhone mobile client.
2. MacBook secondary-computer client.
3. Persistent (disk-backed) permission/pairing/device storage — memory is
   already persistent; these three are still in-memory.
4. Microphone-based voice input/output (Hebrew + English) using the
   provider-agnostic `SpeechToText`/`TextToSpeech` interfaces already
   defined in `src/types/voice.ts`, for channels other than the phone
   gateway (which already has voice via Twilio).
5. Additional device tools behind the same registry/permission model:
   safe application control, screenshots, broader (still non-destructive)
   filesystem access, richer context events (`active_window.changed`,
   `user.idle`, etc.) — kept low-frequency and privacy-conscious.
6. Growing the status dashboard from read-only (today) into a real visual
   control surface — device pairing approval, confirmation prompts, and
   memory browsing from the browser instead of only the terminal/CLI.
7. Device-to-device communication.
8. A spoken-passphrase equivalent of Face ID for the phone channel — the
   dashboard now has real WebAuthn (Face ID/Touch ID); the phone gateway
   has no analogous identity check beyond the optional
   `TWILIO_ALLOWED_CALLERS` allowlist. A verified passphrase (checked
   against Twilio's own speech-to-text) is a reasonable next step; genuine
   voiceprint biometrics would need a separate paid vendor and is a
   bigger decision than a config value.
