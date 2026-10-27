# JarvisApp (iPhone)

The first real native iPhone app for JARVIS — pulled forward from
"deferred" (see `CLAUDE.md`'s 2026-10-27 entry) at David's explicit
request. Written in a Linux Claude Code environment with **no Xcode, no
iOS SDK, and no Metal compiler** — every file here is written carefully
against real, current Apple API names, but **none of it has been
compiled, run, or seen a simulator/device**. Treat this exactly like
`agents/imac/JarvisAgent` before its own first real build: a careful,
honest first draft, not a verified artifact.

## Why this exists, and why it can't be a WebView

A separate effort rebuilt `ui/hologram/` as a web-based "Core" UI for
Mac/desktop browsers. It cannot deliver real "Hey Jarvis" background
listening on iPhone: every iOS browser (Safari, and Chrome/Firefox-on-iOS,
which Apple requires to use WebKit underneath) has unreliable/non-functional
continuous background speech recognition, and no web page runs at all with
the browser closed. This app exists specifically to get a genuinely native
microphone/Speech-framework pipeline, which still can't run in the
background (see "What this app can and cannot do" below) but at least
works reliably while open — and to get Siri/App Intents integration, a
real on-demand camera, and Liquid Glass chrome, none of which a web page
can do on iOS at all.

This is **not** a WebView wrapper around `ui/hologram/`. The Core here is
rendered natively (RealityKit, see `Core3D/`), the UI is native SwiftUI,
and the voice pipeline is native `Speech`/`AVFoundation` — no embedded
browser anywhere.

## Project structure: XcodeGen, not a hand-written `.xcodeproj`

This ships `project.yml` (an [XcodeGen](https://github.com/yonaskolb/XcodeGen)
spec) instead of a `JarvisApp.xcodeproj/project.pbxproj` file written by
hand. Reasoning, stated plainly: a real `.xcodeproj` is a GUID-keyed plist
format that Xcode itself normally generates and is notoriously easy to
corrupt by hand — a single wrong object reference doesn't just fail to
build, it can fail to *open* in Xcode at all, which is a strictly worse
failure mode than "doesn't compile yet" for an artifact nobody here can
test. XcodeGen's `project.yml` is plain, readable YAML — the kind of file
this sandbox can write correctly with confidence — and generating the
actual `.xcodeproj` from it is a single well-tested command run on a real
Mac:

```sh
brew install xcodegen   # one-time
cd ios/JarvisApp
xcodegen generate       # produces JarvisApp.xcodeproj
open JarvisApp.xcodeproj
```

A plain SwiftPM executable (the pattern `agents/imac/JarvisAgent` uses)
was ruled out, per the task's own instructions: App Intents, camera usage
descriptions, and proper code signing/entitlements for a real App
Store/TestFlight-bound app need a genuine Xcode application target, not a
command-line SwiftPM product.

**Before this builds on a real machine**: open `project.yml` and set
`DEVELOPMENT_TEAM` to David's real Apple Developer Team ID (left blank
intentionally — not something to invent), then run `xcodegen generate`.

## Layout

- `JarvisApp.swift` — `@main App`, `WindowGroup { RootView() }`.
- `Connection/MessageProtocol.swift` — ported near-verbatim from the Mac
  agent's file of the same name (pure Foundation, platform-agnostic
  wire protocol). `deviceType`/`platform` are `"iphone"`/`"ios"`.
- `Connection/CoreConnection.swift` — ported near-verbatim; `URLSessionWebSocketTask`
  needed no changes for iOS.
- `Connection/JarvisConnectionManager.swift` — the SwiftUI-facing
  `ObservableObject` that owns the connection, pairing, and message
  dispatch — the counterpart to the Mac agent's `JarvisAgentApp`
  (`main.swift`).
- `Identity/DeviceIdentity.swift`, `Identity/KeychainStore.swift` — ported,
  with `KeychainStore`'s doc comment explaining why iOS's version is
  simpler than the Mac agent's (no ad-hoc-signature Keychain scoping
  problem on a properly provisioned/signed iOS app).
- `Voice/SpeechEchoClassifier.swift` — copied verbatim from the Mac agent
  (pure string-matching logic, zero AppKit/macOS dependency).
- `Voice/VoiceController.swift` — the foreground "Hey Jarvis" wake-word +
  barge-in pipeline, modeled directly on the Mac agent's
  `WakeWordListener.swift`. **Read its header comment on the hard
  platform constraint before assuming this behaves like the Mac agent.**
- `Camera/CameraController.swift`, `Camera/CameraPreviewView.swift` —
  JARVIS's first camera capability anywhere in this codebase. On-demand
  permission only (requested the moment "open the camera" actually runs,
  never pre-authorized).
- `Tools/ToolRegistry.swift`, `Tools/CameraTools.swift` — this app's own
  device-side tool allowlist (`open_camera`/`close_camera`), the same
  named-compiled-in-functions-only pattern as the Mac agent's
  `AgentToolRegistry` — no generic "run this" entry point exists here
  either.
- `Core3D/CoreShaders.metal`, `Core3D/CoreRealityView.swift` — the native
  3D Core. See `CoreShaders.metal`'s own header comment for the full
  reasoning on choosing RealityKit's `CustomMaterial` over SceneKit's
  shader modifiers (the latter are deprecated as of iOS 26 — confirmed via
  Apple's own current documentation) and for exactly which Metal-side
  accessor method names are confirmed vs. reasoned-but-unverified.
- `Intents/JarvisIntents.swift` — `StartListeningIntent`/`OpenCameraIntent`
  + `JarvisAppShortcuts` (App Intents framework — the real "Hey Siri, ask
  Jarvis…" launch path).
- `UI/RootView.swift`, `UI/ChatSheetView.swift`, `UI/PairingView.swift`,
  `UI/CameraSheetView.swift` — see each file's own header comment for
  exactly what's on screen; summarized in this task's final report too.
- `Resources/Info.plist`, `Resources/JarvisApp.entitlements` — permission
  usage strings + an (currently empty, intentionally real) entitlements
  file.

## What this app can and cannot do (read this before relying on it)

- **No true background "Hey Jarvis."** iOS gives no third-party app a way
  to keep a live `SFSpeechRecognizer` + `AVAudioEngine` session running
  with the app closed or backgrounded. `VoiceController` only ever
  listens while `JarvisApp` is in the foreground (`scenePhase == .active`).
  The real mitigation is `Intents/JarvisIntents.swift`'s `StartListeningIntent`
  — "Hey Siri, start listening in Jarvis" launches the app directly into
  a listening state. This is Apple's own documented, structured-phrase-only
  mechanism (not open-ended dictation passthrough) — see that file's
  header comment.
- **Camera is on-demand only.** Permission is requested, and the capture
  session starts, only when `open_camera` actually runs (voice command,
  App Intent, or the manual camera button) — never at launch.
- **Chat sheet is not wired to Core's text-turn path yet.** `ChatSheetView`
  has real, working UI (text input, attach button, message list) but its
  `send()` only appends locally today — see its own `send()` doc comment.
  Wiring it to an actual Core text-turn message is a small, real follow-up,
  left undone rather than half-built in this first pass (voice IS fully
  wired end to end: `voice.transcript` out, `voice.reply` in).
- **No proactive-announcement reply-capture window.** Unlike the Mac
  agent's `speakProactiveAnnouncement`, this app's `handleProactiveAnnounce`
  speaks the announcement but immediately reports "nothing heard" rather
  than listening for a reply — see `JarvisConnectionManager.swift`'s own
  comment on this. A due/urgent reminder should still go out over
  Telegram/phone (channels that work regardless of this app's state), not
  rely on this path today.
- **No vision ("what do you see") hookup.** `CameraController.captureStillFrame`
  is a deliberate, unimplemented seam for this — see its own doc comment.

## Device pairing

Follows the exact same real flow `agents/imac/JarvisAgent` and Core
already implement (`src/devices/pairing/PairingService.ts`,
`JarvisWebSocketServer.ts`'s `handleApproveHttp`) — no new backend auth
code was needed or added. `device.register` → Core-issued pairing code →
`bun run approve-device <id> <code>` on the Core machine →
`pairing.approved` with a credential this app saves to the iOS Keychain.
`src/types/devices.ts`'s `DeviceType` already included `"iphone"` before
this task started (confirmed by reading it) — Core needed zero changes to
accept this app as a device.

## Backend changes this app required

Two new Core device tools, `OPEN_CAMERA`/`CLOSE_CAMERA`
(`src/tools/system/OpenCameraTool.ts`, `CloseCameraTool.ts`), registered in
`src/index.ts`. Both pass `bun run typecheck` (0 errors) and `bun test`
(all tests, including two new test files for these tools). No other
backend code changed — `DeviceType`/`protocol.ts`/`DeviceRegistry` already
supported an `"iphone"` device type generically.

`tests/security/agentToolParity.test.ts` (a pre-existing Core<->Mac-agent
tool-name parity check) was extended to also recognize this app's own
`Tools/` directory, since `open_camera`/`close_camera` are iPhone-only
tools with no Mac-agent equivalent — see that test file's updated comment.

## Honest build/test status

- **Written**: every file above, against real, current API names I could
  confirm (see the PR description / final report for exactly which Apple
  documentation pages were checked, and which specific method names in
  `CoreShaders.metal` are reasoned-but-unconfirmed).
- **Not compiled**: no Xcode, no Swift iOS SDK, no Metal compiler in this
  sandbox. `xcodegen generate` itself has never been run against
  `project.yml`.
- **Not run**: no simulator, no device.
- **Not tested**: no XCTest/unit tests were added for this app's own Swift
  code (no way to run them here); the only real, passing tests from this
  task are the backend TypeScript ones listed above.
- **Not verified**: the Liquid Glass UI, the RealityKit Core visual, the
  voice pipeline, the camera flow, the App Intents/Shortcuts integration,
  and the pairing flow have never been seen running. Real device/Xcode
  validation is the necessary next step before this is anything more than
  a careful first draft — exactly the same standing caveat every Swift
  artifact in this repository carries.
