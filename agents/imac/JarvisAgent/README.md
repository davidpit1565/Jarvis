# JarvisAgent (iMac)

Swift source for the macOS agent that will let JARVIS Core execute
approved tools on the primary iMac. **This has never been compiled or run.**
The Claude Code environment building it is Linux and has no Xcode, macOS
SDK, or Swift macOS runtime — every file here is written against the
Phase 2 architecture but is unvalidated source only.

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

## What requires real iMac validation

Everything. Specifically: Swift compilation itself, Keychain read/write,
`NSWorkspace.frontmostApplication`, `launchd` load/restart behavior, actual
WebSocket connectivity to a running JARVIS Core, code signing/notarization,
and any Accessibility/local-network permission prompts.

## Security

The only implemented tool is `GET_ACTIVE_APPLICATION` (app name + bundle
ID only, no window contents). There is intentionally no shell execution,
AppleScript execution, sudo, filesystem write/delete, or input automation
anywhere in this source.
