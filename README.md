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
- Voice (speech-to-text / text-to-speech)
- Browser automation
- Arbitrary shell/AppleScript execution, sudo, process injection
- Unrestricted keyboard/mouse/application automation
- Any destructive filesystem operation
- A confirmation UI for `CONFIRM`/`DANGEROUS` permission levels
- Persistent (disk-backed) device registry, permission grants, or pairing
  store — all in-memory, matching Phase 1's pattern
- Continuous/high-frequency context monitoring (e.g. streaming
  `active_window.changed` events)

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
│   └── system/         GET_ACTIVE_APPLICATION — device tool (iMac first)
├── permissions/         PermissionService — (userId, toolId, deviceId) grants
├── memory/              MemoryStore — SQLite-backed explicit key/value store
├── devices/
│   ├── registry/        DeviceRegistry — device metadata + role assignment
│   └── pairing/         PairingService — pairing codes, credential hashes
├── communication/websocket/
│   ├── protocol.ts               Typed, validated envelope protocol
│   ├── DeviceConnectionManager.ts  Owns connections + tool request/response lifecycle
│   └── JarvisWebSocketServer.ts    Thin transport: bytes <-> validated messages
├── config/              Environment variable loading and validation
└── types/               Shared TypeScript types across all modules

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
- Device-scoped permission grants: authorizing a tool on one device never
  authorizes it on another.

## Current limitations

- Only two tools exist: `READ_ONLY_FILE_INFO` (local) and
  `GET_ACTIVE_APPLICATION` (device — app name/bundle ID only).
- `CONFIRM` and `DANGEROUS` permission levels are defined but always
  denied — no confirmation flow exists yet.
- DeviceRegistry, PermissionService, and PairingService are all in-memory
  and reset on restart.
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
  suite (`bun test`, 110+ tests)
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
  restart-and-reconnect using the stored credential hasn't been confirmed)
- `NSWorkspace.frontmostApplication` — an actual `GET_ACTIVE_APPLICATION`
  tool call executed end to end from Core through the Agent
- Menu bar UI rendering and permission prompts
- `launchd` load/restart/persistence behavior
- Code signing/notarization

## Planned future phases

1. iPhone mobile client.
2. MacBook secondary-computer client.
3. Confirmation flow for `CONFIRM`/`DANGEROUS` tools, plus persistent
   permission/pairing storage.
4. Voice input/output (Hebrew + English, provider-agnostic STT/TTS)
   layered on top of the existing conversation loop.
5. Additional device tools behind the same registry/permission model:
   safe application control, screenshots, broader (still non-destructive)
   filesystem access, richer context events (`active_window.changed`,
   `user.idle`, etc.) — kept low-frequency and privacy-conscious.
6. Device-to-device communication.
