# JARVIS

JARVIS is a personal AI assistant project. The long-term vision connects a
MacBook, an iMac, and an iPhone into one system where Claude reasons about
what to do, and JARVIS executes actions on the user's behalf — with
persistent memory, permissioned tool access, and voice interaction.

This repository is at the very beginning of that vision.

## Phase 1 scope

This phase builds and validates the **JARVIS Core foundation only**. It
proves one loop end to end, entirely in a single local process:

```
USER → JARVIS → CLAUDE → TOOL DECISION → PERMISSION CHECK
     → TOOL EXECUTION → TOOL RESULT → CLAUDE → RESPONSE
```

**Explicitly out of scope for Phase 1** (not implemented, not stubbed as
real functionality):

- MacBook agent, iMac agent, iPhone client
- Voice (speech-to-text / text-to-speech)
- Browser automation
- Arbitrary terminal/shell execution
- Any destructive filesystem operation (write, delete, modify)
- Authentication beyond a placeholder `userId`
- A confirmation UI for `CONFIRM`/`DANGEROUS` permission levels

## Architecture

```
src/
├── core/
│   ├── conversation/   ConversationManager — in-memory turn state
│   ├── brain/          ClaudeBrain — talks to Anthropic, never executes tools
│   ├── events/         EventBus — typed pub/sub for orchestration events
│   └── orchestrator/   Orchestrator — the central control loop
├── tools/
│   ├── registry/       ToolRegistry — allowlist of tools Claude may call
│   └── filesystem/     READ_ONLY_FILE_INFO — the one tool in Phase 1
├── permissions/        PermissionService — grants + permission levels
├── memory/             MemoryStore — SQLite-backed explicit key/value store
├── devices/registry/   DeviceRegistry — device metadata, no live devices
├── communication/websocket/  Typed message protocol + minimal server
├── config/             Environment variable loading and validation
└── types/              Shared TypeScript types across all modules
```

Design principles carried through every module:

- **Claude reasons, JARVIS executes.** `ClaudeBrain` only returns text and
  requested tool calls — it never has the ability to run a tool. The
  `Orchestrator` is the sole place that decides whether a tool actually runs.
- **Every tool requires an explicit permission level** (`READ`,
  `SAFE_ACTION`, `CONFIRM`, `DANGEROUS`), checked before execution.
- **Tools are allowlisted** through the `ToolRegistry` — nothing runs that
  wasn't explicitly registered.
- **The Core does not assume macOS.** Nothing here depends on a specific
  operating system; device-specific behavior is designed to live behind
  future device agents, not in Core.
- **No secrets in git.** Configuration is loaded from environment
  variables and validated at startup; `.env` is git-ignored.

## Requirements

- [Bun](https://bun.sh) (developed against 1.3.x)
- An Anthropic API key

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

```bash
bun run dev
```

On startup this registers the one available tool, opens the local memory
database, and starts the WebSocket server. No device connects
automatically — this only proves the transport and protocol exist.

## Test

```bash
bun run typecheck
bun test
```

Tests use a scripted mock `Brain` implementation and never call the real
Anthropic API, so the suite runs without network access or a real API key.

## Current limitations

- Only one tool exists (`READ_ONLY_FILE_INFO`), and it can only report
  whether a file exists, its type, and its size — it cannot read contents.
- Permission grants are in-memory and reset on restart; there is no
  persistent ACL store yet.
- `CONFIRM` and `DANGEROUS` permission levels are defined but always denied,
  since no confirmation flow exists yet.
- The WebSocket server validates and acknowledges messages but does not yet
  dispatch real tool requests to a connected device — no device agent
  exists to receive them.
- Memory is a flat key/value store with substring search; there is no
  embeddings-based or semantic search.
- There is no authentication; `userId` is passed in directly by the caller.

## Planned future phases

1. Confirmation flow for `CONFIRM`/`DANGEROUS` tools, plus persistent
   permission grants.
2. First real device agent (likely MacBook) as a WebSocket client
   implementing the existing protocol.
3. Additional tools behind the same registry/permission model: safe
   application control, screenshots, broader (still non-destructive)
   filesystem access.
4. iPhone client.
5. Voice input/output layered on top of the existing conversation loop.
6. Device-to-device communication and a richer device capability model.
