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
  is worth remembering. Upserts by key — saving the same key again
  replaces the old value rather than adding a conflicting second row.
- **`SEARCH_MEMORY`** (`src/tools/memory/SearchMemoryTool.ts`) — `READ`
  level. Lets Claude recall previously saved facts by a text fragment
  before answering, matched against either the key or the value — "what
  did I say about my dog" finds a fact even when "dog" only appears in
  the value, not the key.
- **`DELETE_MEMORY`** (`src/tools/memory/DeleteMemoryTool.ts`) —
  `SAFE_ACTION`, standing-granted. Actually forgets a fact by key, for when
  it's no longer true and there's nothing to replace it with. Undoable
  via `UNDO_LAST_ACTION` (see below) — its value is fetched right before
  the delete so "undo that" can restore it.

This is the first real step toward "JARVIS knows things about you between
conversations" rather than only within a single session.

## JARVIS knows what time it actually is

A real gap found in this session's own research: JARVIS never told Claude
the current date/time at all. Training data has no idea what day it is
right now, so "remind me tomorrow at 9am" or "in two hours" had no ground
truth to resolve against — the model could only guess. Every turn now
includes the current date/time in both UTC and the configured local
timezone (`src/core/time/currentTimeNote.ts`, part of the same
`contextProvider` mechanism as due-reminder surfacing —
`src/core/buildContextNote.ts`). Set `JARVIS_TIMEZONE` (an IANA name like
`Asia/Jerusalem`; validated at startup) to your actual timezone — it
defaults to UTC, which is almost certainly not where you actually are.

## Reminders / tasks

A separate SQLite-backed store (`src/reminders/ReminderStore.ts`,
`JARVIS_REMINDERS_DB_PATH`) for things to *do*, not facts to recall — a
reminder has a lifecycle (pending, then completed), a memory doesn't:

- **`CREATE_REMINDER`** (`SAFE_ACTION`, standing-granted) — creates a
  reminder/task, optionally with an ISO 8601 `dueAt` Claude resolves from
  whatever the user actually said ("remind me at 6pm"). Optionally pass
  `recurrence` (`"daily"`/`"weekly"`, requires `dueAt`) for a repeating
  reminder — "remind me every day to take my medication."
- **`LIST_REMINDERS`** (`READ`) — pending reminders by default, soonest-due
  first (undated ones last); pass `includeCompleted` to see everything.
- **`COMPLETE_REMINDER`** (`SAFE_ACTION`, standing-granted) — marks one
  done by id. For a recurring reminder with a `dueAt`, this also creates
  the next occurrence (same text/recurrence, `dueAt` advanced by one day/
  week) — it keeps recurring instead of vanishing after the first
  completion. A recurring reminder with no `dueAt` has nothing to advance
  from, so it completes like a normal one-off.
- **`UPDATE_REMINDER`** (`SAFE_ACTION`, standing-granted) — edits an
  existing reminder's text, due date, and/or recurrence in place
  ("actually make that 7pm instead," "stop that reminder from
  repeating"), without losing its id/createdAt.
- **`DELETE_REMINDER`** (`SAFE_ACTION`, standing-granted) — permanently
  removes a reminder created by mistake or no longer relevant. Distinct
  from `COMPLETE_REMINDER`: this is for one that should never have
  existed, not one the user actually did. Undoable via `UNDO_LAST_ACTION`
  (see below) — its text/dueAt/recurrence are fetched right before the
  delete so "undo that" can recreate it.

**Proactive, not just reactive**: `Orchestrator` accepts an optional
`contextProvider` callback, called fresh on every turn to add extra
system-prompt context that can change between messages
(`src/reminders/dueRemindersNote.ts`, wired in `src/index.ts`). Wired to
due/overdue reminders — before this, JARVIS could only ever tell you about
a reminder if you asked; now it's told, at the start of any conversation
(terminal or phone), to naturally mention anything due or overdue, the way
an actual assistant would bring it up unprompted. The provider is a plain
callback rather than a concrete `ReminderStore` dependency, so the
Orchestrator itself stays decoupled from any specific source of "things
worth mentioning right now."

Overdue reminders and reminders **due soon** (within the next 60 minutes
by default) are surfaced as two separate sections — "was due 3 days ago"
and "starts in 20 minutes" call for a different tone, so they're never
flattened into one list.

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
raw record of what was actually said. Its `limit` is capped at 100 even
if a caller asks for more, so one request can't pull the entire stored
transcript history.

**`CLEAR_CONVERSATION_HISTORY`** (`DANGEROUS`) lets the user actually erase
that transcript — a real "forget everything we've talked about," not just
a way to search it. Unlike `SAVE_MEMORY`/reminders' `SAFE_ACTION`-level
deletes (standing-granted, no per-call confirmation), this is `DANGEROUS`:
it's irreversible and total (every turn, not one record), so it always
requires a fresh confirmation even with the standing grant JARVIS has —
see the confirmation flow below.

## Confirmation flow for CONFIRM / DANGEROUS tools

`CONFIRM` and `DANGEROUS` tools now have a real approval path instead of
being unconditionally denied:

- A standing `PermissionService` grant for one of these tools means "the
  user has opted in to being asked" — it is never treated as "skip
  asking." The actual gate is a fresh `ConfirmationService.requestConfirmation()`
  call on **every single invocation**, no exceptions.
- `src/core/confirmation/ConfirmationService.ts` defines the gate as a
  small `ConfirmationPrompter` function (`(request) => Promise<boolean>`),
  decoupled from any particular UI. The terminal chat session uses
  `confirmViaChat` (asks in the terminal via `readline.question()`); a
  future richer channel (a push notification, say) is just a different
  prompter passed to the same `ConfirmationService` — no change needed in
  the `Orchestrator`.
- The `Orchestrator` calls this gate from one shared `authorize()` method
  used by both local and device tool execution, so the policy can't drift
  between the two paths.
- **Bounded by a 60-second timeout that defaults to deny**, as a backstop
  for any prompter that never answers.
- **Phone sessions (inbound calls and outbound wake-up calls) use a
  separate `ConfirmationService` that denies immediately**, rather than
  sharing the terminal's — found and fixed during this session's own
  review: a `CONFIRM`/`DANGEROUS` tool call mid-call (e.g.
  `UNLINK_CALENDAR`, `CLEAR_CONVERSATION_HISTORY`) would otherwise have
  silently routed to the terminal's `confirmViaChat`, hanging the live
  call for the full 60-second timeout while nobody at the terminal could
  see or answer it, before auto-denying anyway. An immediate denial isn't
  a workaround for that limitation — voice confirmation of a real,
  high-impact action is inherently unreliable (background noise, a
  misheard "yes," someone else picking up the phone), so denying
  outright and having Claude tell the caller to do it from the terminal/
  dashboard instead is the actually-correct behavior here.
- **Rate-limited per tool+user** (5 attempts per 5 minutes, the same
  `RateLimiter` class used for pairing/login endpoints): past the limit,
  a request is denied immediately, without even reaching the prompter.
  Every attempt counts whether approved or denied — the same
  defense-in-depth reasoning as the HTTP rate limits elsewhere in this
  project, aimed at a compromised/misbehaving channel hammering the
  human with repeated confirmation prompts for the same tool (a real
  problem on a phone call specifically, where each prompt is a live
  interruption, not just a log line).
- **Telegram sessions get a real confirmation prompt, not the phone's
  auto-deny.** Unlike a live call, a Telegram chat is a reliable
  bidirectional text channel — exactly as capable as the terminal's
  `confirmViaChat` of asking a real yes/no question and waiting for a real
  answer. `TelegramGateway.awaitConfirmation()` sends the question to that
  chat and resolves once the next message from it is recognized as
  yes/no/כן/לא (an unrecognized reply re-prompts instead of being treated
  as a new conversation turn); `src/index.ts` gives each Telegram chat its
  own `ConfirmationService` built from this prompter. If the 60-second
  timeout fires before a reply arrives, that one pending entry for the
  chat goes stale until overwritten by the next confirmation for the same
  chat — a bounded, low-consequence edge case, not a leak that grows over
  time.

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

### Revoking a lost/stolen device

```bash
curl -X POST https://<your-app>.fly.dev/pairing/revoke \
  -H "Content-Type: application/json" -H "X-Jarvis-Admin-Token: <your admin token>" \
  -d '{"deviceId": "<the device's id, from GET /status>"}'
```

Immediately invalidates that device's credential and, if it's currently
connected, closes its socket right away rather than waiting for it to
disconnect naturally. The device keeps showing up in `GET /status` (its
history isn't erased) but can never reconnect without a brand-new pairing
code approved again. This is the only way to cut a device off without
shell access to wherever Core actually runs. It also emits a
`"device.revoked"` event that clears the device's standing
`PermissionService` grants (`OPEN_APPLICATION`/`QUIT_APPLICATION`/
`OPEN_URL`) — defense in depth: those grants otherwise never expire on
their own, so this ensures a revoked device that somehow reconnected
anyway (a bug elsewhere in the pairing/auth path) can't silently keep
acting on its old standing trust.

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
- Capped at 40 back-and-forth turns per call — JARVIS ends the call itself
  (a spoken goodbye, then `<Hangup/>`) rather than letting one very long or
  automated call run up Twilio/Anthropic cost indefinitely with no natural
  end. Generous for an actual conversation; resets on the next call.
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
6. Optionally set `TWILIO_VOICE` to pick a different English `<Say>` voice,
   and `TWILIO_VOICE_PITCH`/`TWILIO_VOICE_RATE` to adjust how deep/slow it
   sounds. The default, `Polly.Matthew` (Amazon's Standard, non-Neural
   engine) lowered by `-15%` pitch and slowed to `92%` rate, is a
   deliberate choice: it's meant to sound like a machine speaking, not a
   real person — quiet, deep, distinct from a human voice, on purpose. If
   you'd rather have the more natural-sounding option instead, set
   `TWILIO_VOICE=Polly.Matthew-Neural` (note Neural voices only honor the
   `rate` part of `TWILIO_VOICE_RATE`, not the pitch — see
   [Twilio's voice list](https://www.twilio.com/docs/voice/twiml/say/text-speech)
   for further options, including newer Generative voices like
   `Google.en-US-Chirp3-HD-Charon` if enabled on the account).
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
  integration (`Google.he-IL-Standard-D` by default — Standard rather than
  WaveNet, for the same "sound like a machine, not a person" reason as the
  English voice above — overridable via `TWILIO_VOICE_HEBREW`).

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
actual sound of `Polly.Matthew` with the pitch/rate SSML applied (or any
other voice) hasn't been heard — only that the TwiML correctly requests
it.

## Wake-up calls (JARVIS calls you)

The phone gateway above is inbound-only — you call JARVIS. Setting
`TWILIO_ACCOUNT_SID`, `TWILIO_FROM_NUMBER`, and `JARVIS_OWNER_PHONE_NUMBER`
(all three together, on top of the phone gateway's own `TWILIO_AUTH_TOKEN`/
`TWILIO_PUBLIC_BASE_URL`) enables the reverse: JARVIS actually calls *you*,
on a recurring daily schedule — a real alarm clock replacement, not just
another reminder notification.

- **`CREATE_WAKEUP_CALL`** (`SAFE_ACTION`, standing-granted) — just tell
  JARVIS "wake me up at 7am every day" and it schedules a recurring daily
  call at that time (`src/wakeup/WakeUpCallStore.ts`,
  `JARVIS_WAKEUP_CALL_DB_PATH`). **`LIST_WAKEUP_CALLS`** (`READ`),
  **`UPDATE_WAKEUP_CALL`** (`SAFE_ACTION`, standing-granted — edits the
  time/label/enabled state in place, e.g. "actually wake me up at 8
  instead" or "turn off my wake-up calls for now" without deleting the
  schedule, without losing its schedule history), and **`DELETE_WAKEUP_CALL`**
  (`SAFE_ACTION`, standing-granted) round out managing the schedule
  entirely through conversation.
- A scheduler tick every 30 seconds (`src/index.ts`) checks the schedule
  against the current time in `JARVIS_TIMEZONE` and places any due call
  via `TwilioOutboundCaller` (Twilio's REST API). Guarded against
  double-dialing two ways: `lastTriggeredDate` per entry once a call
  actually completes, and an in-memory in-flight set
  (`getDueWakeUpCalls`'s `excludeIds`) for the narrower case a placeCall()
  is still in flight (a slow/stuck request) when the next tick fires
  within the same matching minute — found and fixed during this session's
  own review, since `lastTriggeredDate` alone only closes the gap after
  the call already finished.
- When you answer, JARVIS doesn't play a canned recording — it asks its
  own brain for an opening line first (via the same `channelContext`
  mechanism used for regular calls, but framed as "you placed this call,
  not the user"), so the greeting is genuinely personalized from whatever
  reminders/memory are actually relevant that day. If you push back
  ("I'm tired"), it's explicitly instructed to persuade you further with
  another real, specific reason rather than immediately backing off —
  the way a determined friend would, not a snooze button.
- Real Twilio per-minute cost applies to every call actually placed —
  same pricing as the inbound gateway, just outbound-initiated.
- **A failed alarm call now actually tells you it failed**, instead of
  just failing silently (an alarm that doesn't ring is the one failure
  mode where the phone itself can't tell you anything went wrong): logged
  to the activity feed either way, and — when Telegram/`NOTIFY_USER` is
  configured — pushed there too, since that's the one notification
  channel that doesn't depend on the phone call that just failed.

## Calendar & Gmail integration (Google account)

Lets JARVIS answer "what's on my calendar" / "am I free at 3pm" with your
actual Google Calendar, lets reminders/wake-up calls reference real
meetings instead of only what's been manually typed in, lets you actually
ask it to add or remove events — "add a dentist appointment tomorrow at
3pm" really puts it on your calendar — and lets it search your real Gmail
inbox ("did I get an email from the bank today"), all from one linked
Google account.

**Setup** (Google Cloud Console, one-time, done manually — this can't be
automated from here):

1. Create a project at [console.cloud.google.com](https://console.cloud.google.com)
   (or reuse an existing one) and enable the **Google Calendar API** for it.
2. Configure the **OAuth consent screen** (External or Internal, whichever
   your Google account allows) — you only need to add your own Google
   account as a test user if it stays in "Testing" mode, which is fine for
   a personal assistant.
3. Create an **OAuth 2.0 Client ID** of type "Web application" with an
   authorized redirect URI of exactly
   `<JARVIS_PUBLIC_BASE_URL>/calendar/oauth/callback` (e.g.
   `https://your-app.fly.dev/calendar/oauth/callback`). Copy the resulting
   Client ID and Client Secret.
4. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and
   `JARVIS_PUBLIC_BASE_URL` (plus `JARVIS_ADMIN_TOKEN`, required once
   Calendar is configured — see "Security controls" below).
5. Visit `<JARVIS_PUBLIC_BASE_URL>/calendar/oauth/start?token=<JARVIS_ADMIN_TOKEN>`
   in a browser, approve Google's consent screen — the same one-time
   consent screen covers both Calendar and Gmail read access, requested
   together — and you're linked. `LIST_CALENDAR_EVENTS`, `SEARCH_EMAIL`,
   and the proactive calendar context below all start working immediately,
   no restart needed.

**What's implemented:**

- **`LIST_CALENDAR_EVENTS`** (`READ`) — the user's upcoming events,
  soonest first, via Google's Calendar API v3 (`src/calendar/GoogleCalendarClient.ts`,
  raw `fetch` calls, no SDK dependency, matching this project's existing
  style — see `TwilioOutboundCaller`). Both this and `SEARCH_CALENDAR_EVENTS`
  cap `maxResults` at 50 even if a caller asks for more, so one request
  can't pull an unbounded number of events' full field set.
- **`SEARCH_CALENDAR_EVENTS`** (`READ`) — finds events (past or future) by
  free-text query against title/description/location/attendees, via
  Google's own `q` search parameter — for "when was my dentist
  appointment" or "find the event with Sarah," which `LIST_CALENDAR_EVENTS`
  (upcoming-only) can't answer.
- **`GET_CALENDAR_EVENT`** (`READ`) — fetches one event's full detail by
  id (from a prior list/search result), including its description and
  attendee emails, which listing/searching don't return — for "what's
  that meeting about" or "who's invited."
- **`CREATE_CALENDAR_EVENT`**, **`UPDATE_CALENDAR_EVENT`**, and
  **`DELETE_CALENDAR_EVENT`** (all `SAFE_ACTION`, standing-granted,
  matching `create_reminder`/`update_reminder`/`delete_reminder`) — real
  write access: JARVIS can actually put something on the calendar, edit
  it in place, or take it off, not just read it. `UPDATE_CALENDAR_EVENT`
  sends a partial PATCH (only the given fields), so editing an event's
  time doesn't require deleting and recreating it — which would drop its
  attendees/description for no reason. The OAuth
  scope requested is full `.../auth/calendar` (not `.readonly`) for
  exactly this reason — the permission-level check at the tool layer is
  what actually gates when writes happen, not the OAuth scope.
  **`UNLINK_CALENDAR`** (`DANGEROUS`, like `CLEAR_CONVERSATION_HISTORY`)
  actually disconnects the linked account on request — before this, the
  only way to undo a link was manually deleting the SQLite file.
  `CREATE_CALENDAR_EVENT` always creates the event even if it overlaps an
  existing one — this is never a blocking gate — but checks first and
  returns a non-empty `conflicts` field when it does, so Claude can
  mention the double-booking instead of creating it silently; a failure
  in that check (rather than the create itself) is swallowed, since it's
  a nice-to-have warning, not something worth failing the whole request over.
- **`UNDO_LAST_ACTION`** (`SAFE_ACTION`, standing-granted, registered
  unconditionally — reminders/memory don't require a calendar link) —
  "undo that" right after JARVIS creates/updates/deletes a calendar
  event, or deletes a reminder or a saved fact, actually reverses it, via
  a single-slot `UndoStore` (`src/core/undo/UndoStore.ts`) that tracks
  only the one most recent reversible action, not a full history to walk
  back through. Each action is only actually reversible because
  something remembered what it changed right before acting —
  `DELETE_CALENDAR_EVENT`/`UPDATE_CALENDAR_EVENT`/`DELETE_REMINDER`/
  `DELETE_MEMORY` all fetch first, act second. In-memory only, like
  `PermissionService`'s grants; recording a new action always replaces
  whatever was there.
- **`SEARCH_EMAIL`** (`READ`) — searches the linked Gmail inbox using
  Gmail's own search syntax (`from:x`, `is:unread`, `subject:invoice`,
  `newer_than:2d`, ...) and returns matching messages' subject, sender,
  date, and a short snippet (`src/gmail/GmailClient.ts`, same raw-`fetch`
  style, sharing the same linked account and token store as Calendar — no
  separate OAuth flow). The OAuth scope requested is `gmail.readonly` —
  deliberately read/search only, never send, delete, or modify — and only
  whatever a specific query matches, not a dump of the whole mailbox. This
  is the scoped alternative to "give JARVIS access to all my messages":
  real, working email search, without a blanket mailbox grant.
- **`GET_EMAIL`** (`READ`) — fetches one message's full plain-text body by
  id (from a prior `search_email` result), for when the user asks what an
  email actually says rather than just whether it exists. Same
  `gmail.readonly` boundary as search; walks a multipart message's parts
  preferring `text/plain` over `text/html`.
- **`GET_UNREAD_EMAIL_COUNT`** (`READ`) — just the unread count via
  Gmail's `resultSizeEstimate`, no per-message summary fetch — meaningfully
  cheaper than `search_email("is:unread")` for "do I have unread emails,"
  which only ever needs a number.
- OAuth tokens (the refresh token and current access token) are persisted
  to their own SQLite database (`src/calendar/CalendarTokenStore.ts`,
  `JARVIS_CALENDAR_TOKEN_DB_PATH`) — access tokens are refreshed
  automatically (a minute before actual expiry) whenever a request needs
  one, with no manual re-linking required afterward.
- Upcoming events are woven into the same proactive context mechanism as
  due reminders (`src/calendar/todayCalendarNote.ts`, composed in
  `buildContextNote`) — including into wake-up calls, so "you have a 9am
  meeting" can come from your real calendar, not just what you typed into
  a reminder. A calendar lookup failure (not linked yet, an expired
  refresh token, a Google API hiccup) is treated as "nothing to add,"
  never something that breaks the turn.
- `GET /calendar/oauth/start` is gated by the admin token as a **query
  parameter** (`?token=...`), not the `X-Jarvis-Admin-Token` header used
  everywhere else — this route is meant to be opened directly in a
  browser to reach Google's consent screen, which a fetch header can't
  do. Rate-limited per client IP (same `RateLimiter` as pairing/login/
  backup), so guessing the token from a URL isn't free — past the limit,
  `429` without even checking it. `GET /calendar/oauth/callback` is
  protected by a single-use, server-issued `state` value (real CSRF
  protection), independent of the admin token, since Google's own
  redirect has no way to carry a header.

## Telegram integration

Lets you talk to JARVIS through Telegram, from a bot you add to specific
chats — a scoped alternative to "give JARVIS access to all my messages,"
not a general Telegram inbox reader. There is no code path here that reads
anything outside a chat this specific bot was added to, and (once
`TELEGRAM_ALLOWED_CHAT_IDS` is set) that chat is explicitly allowlisted.

**Setup** (Telegram, one-time, done manually):

1. Message [@BotFather](https://t.me/BotFather) on Telegram, send `/newbot`,
   and follow its prompts to get a bot token.
2. Set `TELEGRAM_BOT_TOKEN` (the token from step 1) and
   `TELEGRAM_WEBHOOK_SECRET` (any long random value, e.g.
   `openssl rand -hex 32`) as environment variables/secrets on wherever
   JARVIS runs.
3. Register the webhook with Telegram (a one-time call, from your own
   machine, not automated by JARVIS itself):
   ```
   curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
     -d "url=<JARVIS_PUBLIC_BASE_URL>/telegram/webhook" \
     -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
   ```
4. Optionally set `TELEGRAM_ALLOWED_CHAT_IDS` to a comma-separated
   allowlist of numeric chat IDs (see "Security controls" below) —
   recommended before adding the bot to more than your own chat. Your own
   chat ID shows up in the first message JARVIS fails to send if it's not
   yet allowlisted, or via `@userinfobot` on Telegram.
5. Message the bot — JARVIS answers, and the same chat keeps its own
   conversation thread for as long as the process runs (unlike a phone
   call, a chat has no natural "hang up").

**What's implemented:**

- `POST /telegram/webhook` (`src/communication/telegram/TelegramGateway.ts`)
  verifies the `X-Telegram-Bot-Api-Secret-Token` header Telegram echoes on
  every request against `TELEGRAM_WEBHOOK_SECRET` before processing
  anything — an unauthenticated webhook here would let anyone drive
  JARVIS's tools with a fabricated "incoming message," no real Telegram
  account required.
- Each chat gets its own `ConversationManager`/`Orchestrator`, created on
  first message and kept in memory for the life of the process — same
  JARVIS, same tools, separate conversation per chat.
- A brain/tool failure mid-message gets a spoken-style error reply back to
  the chat (`"Sorry, something went wrong on my end..."`), never a
  silently dropped message or a crashed webhook handler.
- Only plain text messages are handled — photos, stickers, and other
  message types are silently ignored, since there's nothing meaningful for
  JARVIS to do with them today.
- `/start` and `/help` are answered locally with a canned greeting/help
  message, never reaching the brain — so tapping "start" on a new chat
  doesn't burn a real API call on a message the bot can answer itself.
  Only an exact `/start`/`/help` message triggers this; a message that
  merely contains those words elsewhere is dispatched normally.
- **`NOTIFY_USER`** (`SAFE_ACTION`, standing-granted) — lets JARVIS push a
  text notification to your phone from *any* channel it's currently
  talking to you on, most usefully the terminal/Mac: "tell me on my phone
  when the build finishes" actually reaches your phone. Requires
  `TELEGRAM_OWNER_CHAT_ID` (your own chat ID — distinct from
  `TELEGRAM_ALLOWED_CHAT_IDS`, which is about who may talk *to* JARVIS,
  not where JARVIS talks *first*). The reverse direction — asking JARVIS
  to act on the Mac while talking to it over the phone/Telegram — already
  worked before this, since every channel shares the same tool registry
  and device connection (e.g. `OPEN_APPLICATION` dispatched from a
  Telegram chat reaches the paired Mac exactly the same way it would from
  the terminal).

**Not yet verified**: never exercised against a real Telegram bot/account
— this needs the @BotFather + setWebhook setup above, which hasn't been
done in this environment. What's covered by real tests
(`tests/telegram/`) is the gateway logic (allowlist enforcement, session
reuse per chat, error-reply fallback) and HTTP routing (secret-token
verification, malformed JSON, disabled-gateway 404) against the actual
`Bun.serve` server.

## Weather

Setting `JARVIS_WEATHER_LATITUDE`/`JARVIS_WEATHER_LONGITUDE` (both
required together) enables **`GET_WEATHER`** (`READ`) — a real current
temperature/wind/conditions lookup for that one location, and
**`GET_WEATHER_FORECAST`** (`READ`) — the daily min/max temperature,
conditions, and chance of rain for the next several days (defaults to 3,
capped at 7), for "will it rain tomorrow"/"what's the weather like this
week" — both via [Open-Meteo](https://open-meteo.com)'s free forecast
API. No API key, no account, no cost — matching this project's "as close
to free as possible" goal. Find your own coordinates at any map site
(right-click → "What's here"). `GET_WEATHER`'s result is cached for 5
minutes so several "what's the weather" questions in quick succession
don't each hit Open-Meteo again — a real latency/load saving even though
there's no per-request cost to avoid; a failed request is never cached.

## News

Setting `JARVIS_NEWS_RSS_URL` enables **`GET_NEWS`** (`READ`) — real
headlines from that one RSS feed (any news site's RSS URL works), via a
small regex-based reader (`src/news/RssNewsClient.ts`) rather than a full
XML parser dependency — and **`SEARCH_NEWS`** (`READ`) — filters that same
feed's headlines to ones whose title matches a keyword, for "anything
about X in the news" instead of scanning the unfiltered top 5. No API
key, no account, and deliberately scoped to whichever single feed you
configure, not a general web-wide news aggregator. The fetched feed is
cached for 5 minutes and shared between both tools, so calling either in
quick succession doesn't re-fetch and re-parse the whole feed; a failed
request is never cached.

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

An explicit instruction always overrides the detected language: "answer
me in Hebrew" holds for the rest of the conversation even if you keep
typing/speaking in English afterward, and a lasting version of it ("always
answer me in...") gets saved via `SAVE_MEMORY` so it holds in future
conversations too, not just the current one.

## Security controls

- No arbitrary shell execution, AppleScript execution, sudo, process
  injection, or unrestricted keyboard/mouse/application automation —
  anywhere in Core or the Agent source. Enforced by a real test
  (`tests/security/noArbitraryExecution.test.ts`), not just this
  paragraph: it scans every `.ts`/`.swift` file for `child_process`,
  `Bun.spawn`, `execSync`, `NSAppleScript`, `osascript`, a raw shell path,
  or Swift's `Process()`, and fails if a new one shows up anywhere
  outside one reviewed, allowlisted exception (a fixed `tar` invocation
  for `GET /backup`, no user/model input involved).
- Every capability is an explicitly registered tool with an ID, schema,
  permission level, and (for device tools) a named, compiled-in Agent
  function — never a generic "run this" path.
- **Core and the Agent's device tool lists can't silently drift apart** —
  `tests/security/agentToolParity.test.ts` cross-checks every Core tool
  declared `target: "device"` against the names actually registered in
  the Agent's own `AgentToolRegistry.buildDefault()`, so a device tool
  added to one side without the other (Core requesting a name the Agent
  has no function for, or vice versa) fails CI instead of only showing
  up as a runtime "Unknown tool" error on a real device.
- Prompt-injection defense in the system prompt itself
  (`src/core/brain/systemPrompt.ts`): anything that comes back from a
  tool — a web search/fetch result, an email, a calendar event's text, a
  news headline — is explicitly framed as data to look at, never an
  instruction to follow, with a concrete example of what that looks like
  ("ignore your instructions", "now do X"). Real content fetched from the
  open internet or someone else's email is the one place a malicious
  instruction could plausibly reach JARVIS without the user themselves
  typing it.
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
- `POST /pairing/approve`, `POST /pairing/revoke`, `POST /auth/login`,
  `POST /auth/register-options`, `POST /auth/register`, and
  the WebSocket `device.register` message are all rate-limited (10
  attempts per 5 minutes, per client IP — `src/communication/websocket/RateLimiter.ts`):
  every attempt counts against the limit whether it succeeds or fails, so
  a 6-digit pairing code (or repeated WebAuthn verification/registration
  attempts, or spamming fake device registrations to fill `DeviceRegistry`
  with junk) can't be brute-forced or spammed by hammering the endpoint.
  Registration is already gated behind the admin token, but rate-limiting
  it too means a leaked or guessed token can't be used to hammer the
  endpoint indefinitely either. In-memory
  and per-process, resetting on restart — a deliberate simplicity tradeoff
  for a single-instance personal assistant. "Per client IP" actually means
  the `Fly-Client-IP` header, but **only when `FLY_APP_NAME` confirms this
  process is actually running as a Fly Machine** — falling back to the raw
  socket address otherwise (including local dev/tests and any non-Fly
  deployment of this same Dockerfile, e.g. Railway/Render/a VPS). Two real
  bugs found and fixed during this session's own review, back to back:
  first, behind Fly.io's proxy the raw socket address is Fly's own
  internal hop, the same for every request, silently collapsing every
  caller into one shared rate-limit bucket per route in production; then,
  the initial fix trusted the `Fly-Client-IP` header unconditionally,
  which would have let any caller on a non-Fly deployment set an arbitrary
  value on every request and get a fresh bucket each time — a
  straightforward brute-force bypass, since nothing on those hosts strips
  a client-supplied header of that name the way Fly's own proxy does.
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
- Every Telegram webhook request's secret token is verified against
  `TELEGRAM_WEBHOOK_SECRET` before it reaches the Orchestrator; a missing
  or wrong secret is rejected with `403`, and rate-limited per client IP
  (same `RateLimiter` as pairing/login/backup) so guessing the secret
  isn't free — past the limit, `429` without even checking the token.
  Optional chat allowlist
  (`TELEGRAM_ALLOWED_CHAT_IDS`), same reasoning as the phone caller
  allowlist above: secret-token verification alone only proves the
  request came from Telegram, not which chat it's from.
- Optional Face ID/Touch ID lock for the dashboard (see below): real
  WebAuthn, not a custom biometric integration; registering the first
  credential requires `JARVIS_ADMIN_TOKEN` so setup can't be hijacked.
  `GET /status` is gated by the same session check as the dashboard page
  itself — found and fixed during this session's own review: the page was
  locked, but the JSON feed it polls (devices, activity, token/tool usage,
  record counts) was still served to anyone, unauthenticated, making the
  lock purely cosmetic.
- Every HTTP response carries `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, and `Referrer-Policy: no-referrer`
  (`withSecurityHeaders` in `JarvisWebSocketServer.ts`) — stops the
  dashboard from being framed by another site (clickjacking) and keeps
  this server's own URLs out of any Referer header sent onward.
- The audio waveform's ingest endpoint (`/voice/audio-stream`) only
  exists at all when `JARVIS_AUDIO_WAVEFORM=true`, and — unlike the HTTP
  voice webhooks — is **not** Twilio-signature-verified (a WebSocket
  upgrade carries no such header to check). Anyone who knows the URL
  could open it and send fake audio-shaped messages. This is a low-impact
  gap, not a security hole on the order of the pairing/gather ones: the
  path only ever reduces input to a bare 0–1 amplitude number for a
  cosmetic waveform — it cannot inject text into the Orchestrator or
  trigger any tool call.

## Emergency lockdown (break-glass kill switch)

A single admin-gated switch that stops JARVIS from *doing* anything —
writing, sending, calling, touching a device — while it keeps answering
questions normally. For a stolen phone, a device behaving unexpectedly, or
just wanting to be sure nothing can act while you sort something out.

- **`POST /emergency/lockdown`** (optional JSON body `{"reason": "..."}`)
  activates it. **`POST /emergency/lockdown/lift`** deactivates it. Both
  admin-token-gated and rate-limited the same way as `/pairing/approve`/
  `/pairing/revoke`.
- While active, `Orchestrator` refuses every tool whose permission level
  is above `READ` — before it ever reaches a permission check or a
  confirmation prompt — with a clear error Claude can relay back to
  whichever channel asked (phone, Telegram, terminal). `READ` tools
  (searching memory, checking the calendar, reading email) keep working,
  so JARVIS doesn't go completely silent, it just can't act.
- Applies everywhere at once: the terminal, phone calls, and Telegram all
  share the one `LockdownService` instance, so there's no channel where a
  lockdown quietly doesn't apply.
- `GET /status` reports current lockdown state (`active`/`reason`/
  `activatedAt`) so the dashboard can show it.
- In-memory only, like `PermissionService`'s grants — resets on restart,
  which is the right default for an emergency measure meant to be lifted
  deliberately, not something that should survive a crash-loop as a
  permanent, forgotten lockdown.

## Tool audit trail

Every tool JARVIS actually runs — its name, the exact input, who ran it,
and whether it succeeded — is durably logged to SQLite
(`src/audit/ToolAuditLog.ts`, `JARVIS_TOOL_AUDIT_LOG_DB_PATH`) via the
`tool.executed` event, which now also carries `userId`/`input` for exactly
this reason. Distinct from `ActivityLog`: that's a small, display-only
ring buffer of human-readable strings for the live dashboard (last 30
entries, gone on restart before this session's persistence work); this is
the actual accountability record — "what did JARVIS do, exactly, and
when" — for a `SAFE_ACTION`/`CONFIRM`/`DANGEROUS` tool, in a form that
could genuinely be audited later, not just skimmed live.

## Real cost visibility

Every Claude API call's token usage (input, output, cache write, cache
read) is recorded to SQLite (`src/audit/TokenUsageStore.ts`,
`JARVIS_TOKEN_USAGE_DB_PATH`) and summed into `GET /status` as a
`tokenUsage` field — cumulative tokens plus an `estimatedCostUsd`. Before
this, "how much is JARVIS actually costing me" had no real answer short of
checking the Anthropic console days later.

The cost estimate is a **rough list-price estimate, not an invoice**: it's
computed from Anthropic's published per-model pricing
(`src/audit/estimateCostUsd.ts`) using the standard prompt-caching
multipliers, and only for models this project has explicitly confirmed
pricing for — an unlisted model reports cost as unavailable (`null`)
rather than guessing, since a wrong number is worse than none for
something you're explicitly watching to keep near-free.

Setting `JARVIS_COST_ALERT_THRESHOLD_USD` adds staged budget alerts on top
of this: JARVIS warns (console + the dashboard's activity log) once
cumulative estimated cost crosses 75%, 90%, and 100% of that value, each
stage firing exactly once rather than spamming a warning on every call
past it (`src/audit/CostAlertMonitor.ts`). This is all-time, not a
monthly reset — `TokenUsageStore` only tracks a running total, so a real
recurring budget period would need time-windowed queries this doesn't
have yet.

## Running the brain through a local model gateway instead of Anthropic's API

`JARVIS_ANTHROPIC_BASE_URL` points `ClaudeBrain` at any Anthropic-compatible
HTTP endpoint instead of `api.anthropic.com` — the way to actually cut
Claude API cost to (near) zero if you already run a local model
gateway/router (e.g. [OmniRoute](https://github.com/diegosouzapw/OmniRoute)
or similar Claude Code-style local routers) that exposes free or
subscription-included model access through an Anthropic-shaped API.

**What this actually changes, and what it doesn't:**

- **It only changes where the brain's model calls go.** It has nothing to
  do with how your phone reaches JARVIS — that's entirely the phone
  gateway/dashboard's own networking (see "Phone gateway" and "Cloud
  deployment" above), and needs its own public URL (Fly.io, or a tunnel
  like ngrok/Cloudflare Tunnel if you run Core on your own machine)
  regardless of which model backend the brain talks to.
- **A local gateway only runs while the machine running it is on and
  reachable from wherever JARVIS Core itself runs.** If JARVIS Core runs
  on the same machine as the gateway (e.g. your Mac, in a terminal), this
  works with no extra networking; if Core runs elsewhere (Fly.io), the
  gateway would need to be reachable from there too, not just from your
  Mac's terminal.
- **A gateway that swaps in a different, non-Claude model to stay free is
  a real quality tradeoff, not a free lunch.** JARVIS's tool-calling
  reliability, personality, and Hebrew/English handling are tuned against
  actual Claude models — a different backend model, however capable in
  general, may follow the system prompt and tool-use protocol noticeably
  less reliably. Worth testing directly rather than assuming it'll behave
  the same.
- **The `estimatedCostUsd` figure in `GET /status` stops reflecting
  reality** once requests aren't actually billed at Anthropic's own
  rates — it would keep computing a hypothetical Anthropic cost for
  requests that may not cost anything (or that are billed completely
  differently) through the gateway.
- Deliberately never read from the ambient `ANTHROPIC_BASE_URL`
  environment variable the Anthropic SDK itself would otherwise honor —
  only from this JARVIS-specific variable — so JARVIS never silently
  starts talking to some unrelated local proxy just because one happens
  to be running on the same machine for a different tool.

## Backups

`GET /backup` downloads a single gzip'd tar of every SQLite database
JARVIS uses — memory, reminders, paired-device credentials, WebAuthn
credentials, conversation history, activity log, tool audit trail, token
usage — the only real way to recover from a lost or corrupted data volume,
since nothing else in this project copies these files anywhere.

Always requires `JARVIS_ADMIN_TOKEN` via the `X-Jarvis-Admin-Token`
header, with no "open for local dev" exception: unlike other admin-gated
routes, an unset admin token makes `/backup` 404 rather than serve
unauthenticated, since this endpoint hands out every credential the
server holds. Also rate-limited, same as the other admin endpoints.

```
curl -H "X-Jarvis-Admin-Token: $JARVIS_ADMIN_TOKEN" \
  https://your-jarvis-host/backup -o jarvis-backup.tar.gz
```

This is a best-effort file copy, not a hot/transactional backup — fine
for a single-writer assistant triggered manually, not meant for point-in-
time recovery under heavy concurrent writes.

## Usage summary in /status

`GET /status` also reports a `toolUsage` summary (total calls, error
count/rate, most-used tool, and a per-tool breakdown) computed from
`ToolAuditLog.summary()`, and a `counts` object with the current number
of saved memory facts, total/pending reminders, and retained
conversation-history turns — a quick "how is JARVIS actually being used
and how much does it remember" glance without paging through raw logs or
querying SQLite directly.

Setting `JARVIS_WEEKLY_DIGEST_DAY`/`JARVIS_WEEKLY_DIGEST_TIME` (both
required together, plus a working Telegram/`NOTIFY_USER` setup — see
"Telegram integration" above) pushes this same `toolUsage`/`tokenUsage`
data as a plain-text weekly digest, so "how has JARVIS been doing" shows
up on its own instead of only ever being answerable if you ask
(`src/digest/`). All-time totals, not a per-week reset — labeled as such
in the message itself, matching the underlying stores.

Setting `JARVIS_CHECKIN_AFTER_HOURS` (plus the same Telegram/`NOTIFY_USER`
setup) adds a wellness check-in: once that many hours pass with no
interaction on any channel (terminal, phone, Telegram), JARVIS sends a
"haven't heard from you" message — fires at most once per gap (a new
interaction resets it), not on every tick past the threshold.

Setting `JARVIS_MORNING_BRIEFING_TIME` (24-hour `HH:MM`, plus the same
Telegram/`NOTIFY_USER` setup) sends a daily morning briefing at that
local time — current weather (if `GET_WEATHER` is configured), today's
calendar (if linked), and due/overdue reminders — so the user gets it
unprompted each morning rather than only ever being answerable if asked.
Each section is simply omitted when it isn't configured or has nothing
to report, never shown empty; a calendar/weather lookup failure is
swallowed the same way `todayCalendarNote` already does, never breaking
the send.

## Inspecting what JARVIS remembers

`GET /reminders`, `GET /memory`, and `GET /wakeup-calls` are read-only
JSON views of everything stored in `ReminderStore` (including completed
reminders), `MemoryStore`, and `WakeUpCallStore` — for actually seeing
what JARVIS is tracking without having to ask it in conversation.
`GET /audit-log` (optional `?tool=TOOL_ID` and `?limit=N`) is the same
kind of view over `ToolAuditLog`'s full structured tool-execution trail —
every tool call's exact input, who ran it, and whether it succeeded —
distinct from the aggregate `toolUsage` stats already in `GET /status`.
Same `X-Jarvis-Admin-Token` gating as `POST /pairing/approve`: required
whenever an admin token is configured, optional only for local
development with none set.

## Reliability

A handful of additions aimed specifically at "survives a real cloud
restart/redeploy, not just a dev sandbox" rather than new capabilities:

- The Anthropic client is tuned explicitly (`maxRetries: 4`, `timeout: 30s`
  in `ClaudeBrain`) rather than left at the SDK's own defaults, so a
  transient 429/5xx gets more chances to recover before a phone call or
  chat turn gives up.
- **Device WebSocket connections now have a real heartbeat.** A 2-minute
  idle timeout on the server's WebSocket config closes a connection whose
  underlying TCP session died without a clean close (network drop,
  laptop sleep, a Wi-Fi handoff) — without this, that device would show
  as online on the dashboard, and every tool dispatched to it would only
  fail after its own separate timeout, forever. Paired with a "ping" Core
  sends every connected device every 45 seconds
  (`DeviceConnectionManager.pingAll()`) so a genuinely healthy but quiet
  connection doesn't get closed just for having no tool calls in a
  while — the Agent already replies "pong" to a ping (`main.swift`'s
  existing handler for it, previously unused from Core's side), and that
  reply is itself socket activity that resets the idle timeout. A "pong"
  also bumps the device's `lastSeen` in `DeviceRegistry`.
- Optional one-shot fallback model (`JARVIS_FALLBACK_MODEL`): if the
  primary model call still fails with a 429/503/529 after all of the
  SDK's own retries, `ClaudeBrain` retries once against a configured
  fallback model (e.g. a Haiku model) before giving up — a degraded reply
  during a real provider outage or rate-limit spike beats no reply at
  all. Opt-in only; unset means never fall back. **Not yet verified**
  against a live outage — `isRetryableWithFallback`'s status-code logic
  is unit-tested, but the actual retry-and-recover path needs a real
  429/503/529 from Anthropic to exercise.
- **`ConversationManager` is bounded to the last 50 user turns**, trimming
  whole turns (never mid-turn — that could orphan half of a `tool_use`/
  `tool_result` pair and break the next API call). The terminal chat loop
  runs for as long as the process stays up, with no restart between
  messages — without a cap, it would resend an ever-growing history on
  every single API call forever, a real and unbounded cost that eventually
  risks exceeding the model's context window outright.
- **Every file-backed SQLite store uses WAL journal mode**, not SQLite's
  default rollback journal — lets a read and a write against the same
  store happen concurrently without blocking each other (e.g. the
  dashboard's `/status` reading `MemoryStore` while a conversation is
  actively saving a fact), and is more resilient to a hard kill mid-write.
  Verified live against a real file, not just asserted in code.
- **A paired device survives a restart** — `PairingService` and
  `DeviceRegistry` are now both optionally SQLite-backed
  (`JARVIS_PAIRING_DB_PATH`, `JARVIS_DEVICE_REGISTRY_DB_PATH`). Before
  this, both were purely in-memory: a real gap where every server
  restart/redeploy would forget every approved device's credential *and*
  its assigned role, forcing a full re-pair (a new code, a human approving
  it again) even though nothing about the device had changed. `status`/
  `lastSeen` are deliberately never persisted — a reloaded device starts
  `unknown` until it actually reconnects and proves it, never assumed
  online just because it was before the restart. Verified live end to
  end: registered and paired a simulated device, sent the server a real
  `SIGTERM`, booted a fresh process against the same database files, and
  confirmed the device reconnected with its existing credential (no new
  pairing code needed) with its `primary` role still intact.
- **Abandoned pairing attempts no longer accumulate in memory forever** —
  found and fixed during this session's own review: `PairingService`'s
  pending-pairing map is keyed by `deviceId`, which a client fully
  controls, and an expired entry only ever got cleaned up lazily when
  something looked it up again for that exact deviceId — which an
  abandoned attempt, by definition, never does. `requestPairing` now
  opportunistically purges every other device's expired pending entry on
  each call, the same fix applied to the OAuth CSRF-state map above.
- `GET /health` — unauthenticated, independent of Face ID lock/admin
  token/phone gateway config — wired into both `fly.toml`'s own health
  check and a Dockerfile `HEALTHCHECK`. Also reports `version`
  (`package.json`'s own version, always available, zero setup) and
  `commit` (`null` unless `JARVIS_COMMIT_SHA` is set at deploy time — e.g.
  `fly secrets set JARVIS_COMMIT_SHA=$(git rev-parse HEAD)` — there's no CI
  here to inject it automatically) for confirming exactly which deployed
  commit is actually live after a redeploy.
- **`GET /health` actually tests the data volume, not just reports
  uptime** — every check does a real write-then-delete against the data
  directory and reports `diskWritable`; a full or unwritable disk now
  fails the check (`status: "degraded"`, HTTP 503) instead of silently
  breaking every SQLite write while Fly.io keeps routing traffic to the
  machine as if nothing were wrong.
- Both `SIGINT` and `SIGTERM` (what Fly.io/Docker/Kubernetes actually send
  for a normal stop/redeploy) trigger the same graceful shutdown: stop
  accepting connections, close every SQLite store, then exit.
- A top-level `uncaughtException`/`unhandledRejection` handler logs and
  keeps the process running instead of a single unrelated bug crashing
  every open phone call and device connection at once.
- `Orchestrator.handleUserMessage` rejects a message over 8,000 characters
  before it ever reaches the brain or conversation history — an
  accidental huge paste or a caller trying to run up cost/abuse the phone
  gateway costs nothing and never pollutes conversation history.

## Current limitations

- Local tools: `READ_ONLY_FILE_INFO`, `GET_ACTIVE_APPLICATION`/
  `OPEN_APPLICATION`/`QUIT_APPLICATION`/`OPEN_URL` (device — app name/
  bundle ID only, launching or quitting a named app, or opening an
  http/https URL in the default browser), `LIST_RUNNING_APPLICATIONS`
  (device — names of currently open apps), `LIST_DEVICES` (which paired
  devices exist and whether they're online), memory/reminder/conversation-history/calendar/wake-up-call/
  `SEARCH_EMAIL`/`GET_WEATHER`/`GET_NEWS`/`NOTIFY_USER` tools (see their own sections above). Real internet search/URL reading
  exist separately, as Anthropic's own server-side `web_search`/`web_fetch`
  tools (opt-in via `JARVIS_WEB_SEARCH=true`/`JARVIS_WEB_FETCH=true`), not
  through this registry — see "Real internet search" / "Real URL reading"
  above.
- **No arbitrary automation, by design.** There is no generic "run this
  shell command"/AppleScript/settings-change tool, and never will be —
  every capability the Agent can execute is a named, compiled-in Swift
  function (see `agents/imac/JarvisAgent/Sources/JarvisAgent/Tools/ToolRegistry.swift`'s
  own comment on this), not an interpreter for arbitrary instructions.
  `OPEN_APPLICATION`/`QUIT_APPLICATION`/`OPEN_URL` only launch/quit a named
  app or open an http/https URL via the OS's own public APIs — none of
  them can run a command, a script, or anything else. This is a
  deliberate security boundary, not a missing feature: an assistant with
  unrestricted computer control and a compromised admin token/machine
  becomes a weapon against its own user, not just an inconvenience.
- `PermissionService`'s grants are in-memory, not persisted — but
  device-scoped `SAFE_ACTION` tools (currently `OPEN_APPLICATION`/
  `QUIT_APPLICATION`/`OPEN_URL`) are
  automatically re-granted for any device already holding the `primary`
  role at startup, and granted fresh the moment a device newly receives
  that role (`"device.roleGranted"` event) — so this has no practical
  effect once a device is actually trusted as primary. Every other
  store — memory, reminders, activity log, conversation history, WebAuthn
  credentials, paired-device credentials, calendar OAuth tokens, wake-up
  call schedule, and device identity/role — persists across restarts.
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
