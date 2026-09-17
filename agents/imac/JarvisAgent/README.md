# JarvisAgent (iMac)

Swift source for the macOS agent that lets JARVIS Core execute approved
tools on the primary iMac. Written in a Linux Claude Code environment with
no Xcode/macOS SDK, so it's built blind — **but it has since been compiled
with `swift build` and run on a real iMac**, completing a live
`device.register` → pairing → Keychain-credential flow against a real Core
instance. See "What requires further real iMac validation" below for what
that run did and didn't confirm.

## Architecture

Hybrid menu bar app + `launchd` user agent, sharing one executable:
- `launchd` (`Resources/com.jarvis.agent.plist`) gives login-time start and
  crash recovery, so the agent runs without a Terminal window open.
- A minimal `NSStatusItem` menu bar surface shows connection status and
  offers pair/pause/quit — the beginning of a UI, not a full app.
- Not App Sandboxed: later tools (beyond Phase 2's `GET_ACTIVE_APPLICATION`)
  will need Accessibility/AppleEvents entitlements the sandbox forbids.

## Layout

- `Connection/CoreConnection.swift` — `URLSessionWebSocketTask` client with
  reconnect/backoff. Chosen over `Network.framework` because this agent is
  a WebSocket *client* only; Network.framework's extra control is not
  needed here.
- `Connection/MessageProtocol.swift` — Swift mirror of
  `src/communication/websocket/protocol.ts`'s envelope and payload types.
- `Identity/DeviceIdentity.swift` — persists a random device UUID (not a
  secret) in Application Support.
- `Identity/KeychainStore.swift` — stores the long-lived pairing credential
  in the macOS Keychain. Never logs, never touches disk outside Keychain.
- `Tools/ToolRegistry.swift` + `Tools/GetActiveApplication.swift` — the
  agent-side tool allowlist. There is no generic "run this" entry point;
  only named, compiled-in functions can execute, independent of whatever
  Core sends.
- `StatusBar/StatusItemController.swift` — the menu bar UI.
- `Logging/Logger.swift` — `OSLog` wrapper; never logs credentials.

## What has been validated on a real iMac

- `swift build` compiles this package cleanly.
- The compiled Agent connects to a real Core over `ws://`, sends
  `device.register`, receives its pairing code (printed to the terminal),
  and — after `bun run approve-device <id> <code>` on the Core side —
  receives and saves its credential via `KeychainStore`.

## What requires further real iMac validation

- Keychain persistence across an Agent restart (save path ran; a
  restart-and-reconnect using the stored credential is unconfirmed)
- `NSWorkspace.frontmostApplication` — an actual `GET_ACTIVE_APPLICATION`
  tool call executed end to end from Core through this Agent
- Menu bar UI rendering and permission prompts
- `launchd` load/restart behavior
- Code signing/notarization
- Any Accessibility/local-network permission prompts

## Security

The only implemented tool is `GET_ACTIVE_APPLICATION` (app name + bundle
ID only, no window contents). There is intentionally no shell execution,
AppleScript execution, sudo, filesystem write/delete, or input automation
anywhere in this source.
