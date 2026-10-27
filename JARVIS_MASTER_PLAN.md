# JARVIS — Master Plan (unified from 4 ChatGPT prompts + existing project history)

Owner: David. Written 2026-10-26/27. This supersedes ad-hoc planning scattered across
`CLAUDE.md`, `JARVIS_ROADMAP_AUDIT.md`, and `JARVIS_COMPETITIVE_RESEARCH.md` by tying them
to David's four detailed prompts (brain/memory/autonomy, iPhone app, context/Spotify,
meta-process rules) into ONE tracked plan. Those three files are not replaced — this file
points into them rather than duplicating their content.

**Status legend** (per David's own rule): ממתין (pending) · במחקר (researching) ·
בפיתוח (building) · בבדיקה (testing) · הושלם ואומת (done & verified) · חסום (blocked) ·
נכשל (failed). Nothing is marked done without an actual passing test/verification.

## Cross-prompt analysis (done before any work started)

**Overlaps identified**: all four prompts independently ask for (a) continuous
memory/context, (b) multi-device continuity (Mac/iMac/phone), (c) voice-first
interaction, (d) honest reporting / no fabricated success. These are treated as ONE
requirement each below, not four.

**Contradictions/tensions flagged for David's decision, not assumed away**:
1. Prompt 2 (iPhone) asks for "Hey JARVIS" working from a closed/background app, but also
   explicitly says not to assume this is possible and to verify against real iOS limits.
   **This is a real, hard platform constraint, not a research question** — iOS does not
   let third-party apps run a custom always-on wake-word listener in the background the
   way Siri itself does; a backgrounded app gets a few seconds at best unless using
   specific exempted background modes (audio playback, VoIP, etc.), none of which fit
   "silently listen for a custom phrase." The honest fallback (which the prompt itself
   anticipates) is Siri/Shortcuts-triggered launch, not true always-on. Flagging this now
   per prompt 4's rule "don't wait to present a long plan if the answer is already known."
2. Prompt 2's TestFlight/App Store Connect automation and prompt 1's wish to pay nothing
   requires a real, named cost: **an Apple Developer Program membership is $99/year**, a
   hard prerequisite for App Store Connect API access and TestFlight at all — this is not
   optional infrastructure, it's Apple's own gate. This needs David's explicit approval
   (per his own rule in prompt 1 §8/§9 and prompt 2 §9: never incur a cost without asking)
   before any of that work starts. Everything else in these prompts can be scoped to stay
   free; this one line item cannot.
3. Spotify playback **control** (not just search) requires Spotify Premium on the
   account being controlled — need to confirm which Spotify account(s) David actually has
   before promising playback control works.

## Phase status

### Phase 0 — Understand what already exists (prompt 1 §2, prompt 4 §2)
Status: **הושלם ואומת** for the codebase itself — this was already done across prior
sessions. Evidence: `JARVIS_ROADMAP_AUDIT.md` (210 items, each checked against real
source/tests, not inferred from filenames), `JARVIS_COMPETITIVE_RESEARCH.md` (external
comparison), `bun run typecheck`/`bun test` re-verified clean as of 2026-10-26 (2263 pass,
0 fail on `main` after PR #143; PR #144 open, not yet merged — **David still needs to
decide on #144**, see below). Not re-doing this from scratch; using it as the baseline.

### Phase 1 — Memory & continuity (prompt 1 §4, prompt 3 throughout)
Status: **ממתין**. Existing: `MemoryStore` (flat SQLite key/value, explicit-save-only —
see `JARVIS_ROADMAP_AUDIT.md` #14). Gap vs. the prompts: no automatic background
extraction, no distinction between the 8 memory categories prompt 1 §4 lists (standing
preferences / facts about David / active-project history / past decisions+reasons /
verified actions+results / open tasks / perishable info / uncertain-or-conflicting facts),
no conflict/staleness detection. This is the top priority per prompt 4 §10's own ordering
("strengthen memory and ability to resume prior work" is priority #2, right after fixing
what's broken).

### Phase 2 — Reliable task execution & resumability (prompt 1 §5/§6, prompt 4 §10 priority #3)
Status: **ממתין**. Existing: `Orchestrator` (bounded tool loop, `MAX_TOOL_ITERATIONS=5`),
six separate `setInterval` scheduler loops (reminders, automations, wake-up calls, digest,
check-in, briefing) — no unified persisted task/work queue, no resumption of an
in-progress multi-step task after a restart (see roadmap #2, #26-34). Needed before
"continue where we left off" (prompt 3 §2 "תמשיך מאיפה שהפסקנו") can work reliably, not
just as a lucky side-effect of reminders already being persisted.

### Phase 3 — Context understanding & natural conversation (prompt 3 §2-§6)
Status: **ממתין**. This is intent disambiguation (ask a clarifying question only when
genuinely ambiguous, otherwise just act), situational context (place/activity-aware
answers), and conversational follow-up resolution ("yes, that one" / "not now"). None of
this is built as a distinct capability today — `ConversationManager` keeps raw history,
but there's no intent-ambiguity-detection layer. Depends on Phase 1 (needs real memory to
know what "the projects" usually means for David) and Phase 2 (needs real task state to
answer "what's next").

### Phase 4 — Voice-first, wake phrase, barge-in (prompt 1 §7, prompt 2 §2-§5)
Status: **ממתין**, with real prior art identified (see `CLAUDE.md` — `ethanplusai/jarvis`'s
barge-in/echo-rejection scheduler, worth reimplementing as our own code under its
non-commercial-license-respecting "ideas not verbatim" rule). iOS-side wake phrase is
constrained by the platform limit noted above — the actual plan here is Siri/App
Intents-triggered launch + in-app continuous conversation with barge-in, not true
background "Hey JARVIS."

### Phase 5 — iPhone app, Siri/App Intents, Live Activities, Mac bridge, TestFlight pipeline (prompt 2 whole)
Status: **ממתין**, lowest priority per prompt 4 §10 (explicitly after memory/execution/
context). **App Store Connect/TestFlight cost confirmed live against developer.apple.com
(2026-10-26): Apple Developer Program is $99 USD/year, individual tier, and this is a
hard, unavoidable requirement** for TestFlight distribution (free accounts get none),
App Store Connect API access (key creation requires active paid membership), and any
code-signing that isn't limited to David's own device via a free, weekly-expiring
"Personal Team" profile (max 3 devices/3 apps, can't distribute, can't support unattended
automation since profiles expire every 7 days). **No workaround exists for real TestFlight/
App Store automation — this $99/year needs David's explicit go-ahead before Phase 5's
TestFlight-upload work starts** (per his own rule: never incur a cost without asking).
Confirmed the API itself, once membership exists, covers the full pipeline he wants: build
upload, TestFlight tester/group management, and App Store review submission — not partial.
Confirmed the real security point behind his own CONFIRM/DANGEROUS-tier instinct: the
actual distribution signing certificate's private key must be present on whatever Mac runs
the automation (`fastlane match` exists to encrypt/centralize this, but it's still a real,
high-value secret on that machine, not a free pass around the concern).

**iOS Siri/App Intents/Live Activities/wake-word research done and verified (2026-10-26,
against developer.apple.com + confirmed-live Apple DTS/forum threads):**
- **Background/locked-screen "Hey JARVIS" — confirmed NOT possible the way "Hey Siri"
  works.** No OS hook exists for a third-party custom wake word. The only approximation
  (background-audio mode + local wake-word inference) keeps the system's red/orange mic
  indicator visibly on the whole time, risks App Store rejection under Guideline 2.5.4 if
  the background mode isn't used for real audio playback, and even Apple's own developer
  forums have an *unanswered* open question about whether this is compliant while locked.
  **Realistic promise: tap-to-talk, or listen only while the app is open/foregrounded.**
  Do not promise true invisible always-on background listening.
- **Siri App Intents — confirmed structured-parameters only, not free-form dictation.**
  A third-party app can expose up to 10 `AppShortcut` trigger phrases with typed
  parameters; there is no documented mechanism for Siri to hand raw free-form speech to a
  third-party app the way one might assume from "ask JARVIS anything." **Realistic
  promise: fixed phrases triggering defined actions** ("Hey Siri, ask JARVIS to start my
  morning routine"), not open-ended spoken questions relayed verbatim.
- **Live Activities — confirmed real backend-driven progress tracking is possible.** A
  server can push live updates (APNs `liveactivity` push type) to show real task progress
  (e.g. "JARVIS is building your app, 60%") without the app open, auto-ending after ~8
  hours. Apple does not publish a guaranteed update-frequency budget and has documented
  real throttling incidents — plan minutes-granularity updates, not real-time ticking,
  with no SLA on exact cadence.
- **Action Button (iPhone 15 Pro+ only) — confirmed real, simple win.** Can be user-bound
  to any JARVIS App Shortcut for one-press launch into listening mode — but only on
  Action-Button-equipped phones; confirm which iPhone model David actually has before
  promising this.
- Two things flagged by the research as genuinely unresolved even to Apple's own forum
  posters (not just "we didn't check"): locked-screen wake-word App Review compliance, and
  whether any 2026-era mechanism allows true free-form Siri→app speech passthrough. Worth
  an actual Apple DTS inquiry before spending engineering time chasing either.

### Phase 6 — Spotify integration (prompt 3 §7-§8)
Status: **ממתין**, lowest priority alongside Phase 5 per prompt 4 §10. **Research done
and verified live against developer.spotify.com (2026-10-26):**
- Playback control (play/pause/skip/seek/transfer) confirmed Premium-only in Spotify's
  own current docs (`PREMIUM_REQUIRED` 403 on Free). Search/metadata reads need no
  Premium and no user auth scope at all.
- **Can be built for $0 beyond whatever Spotify Premium David already personally pays
  for** — app registration is free and instant, no approval needed. New apps start in
  "Development Mode" (max 5 allowlisted users) — since only David will use this, that's
  sufficient forever; no need to ever apply for Extended Quota Mode, which Spotify
  restricted to registered businesses with 250k+ MAU as of May 2025 anyway (structurally
  unreachable for personal use, good thing dev mode already covers this).
- Scopes needed: `user-read-playback-state`, `user-read-currently-playing`,
  `user-modify-playback-state` (plus none for search).
- **Open unknown, needs live testing, not just docs**: whether "play it on my computer"
  can wake a fully closed Spotify desktop app, or whether the target device must already
  be open/signed-in to appear in `/me/player/devices` at all. Docs don't say either way;
  community reports (unverified) suggest the app must already be running. Plan a graceful
  fallback message ("open Spotify on your Mac first") rather than assuming it always works.

### Phase 7 — Controlled self-improvement loop (prompt 1 §6)
Status: **ממתין**, explicitly gated: never let the system change its own code,
permissions, or security mechanisms without the existing human-review pipeline (branch →
test → PR → human merge) — this is a process/discipline item, not a new subsystem; the
existing PR pipeline (used for every change in this session) already satisfies the actual
mechanism prompt 1 §6 asks for (propose → test → compare → only then adopt). What's
missing is making David's own stated loop explicit as a named practice, not new code.

## Decisions confirmed by David (2026-10-27)

- **Apple Developer Program**: he already has an account — the $99/year question is
  resolved, no new spend, no approval blocker for Phase 5's TestFlight/App Store Connect
  work when it comes up.
- **Spotify Premium**: confirmed he has it — Phase 6 playback control is unblocked
  whenever it's prioritized.
- **"Hey JARVIS" wake word, Mac side**: he proposed leaving a process running on his
  Mac/computer specifically (not necessarily the phone) so it's "always on" there — turns
  out this **already exists in code**: `agents/imac/JarvisAgent` ships a `launchd` user
  agent (`Resources/com.jarvis.agent.plist`) that starts at login and runs without a
  Terminal window open (better than his own "leave a terminal open" idea), containing
  `Voice/WakeWordListener.swift` — free, on-device, no cloud dependency, listening for
  "Hey JARVIS"/"Jarvis שומע" via Apple's own Speech framework. **Never validated on a real
  Mac's actual microphone/Speech-permission prompts** (this dev sandbox has no macOS/Xcode
  — see `agents/imac/JarvisAgent/README.md`'s own "what requires further real iMac
  validation" list). **Next concrete action is on David's side**: run the agent on his
  real Mac/iMac and confirm the wake phrase actually works and the permission prompts
  appear correctly — this isn't a coding task until that real-world test either passes or
  surfaces a bug to fix.
- Phone-side: per the iOS research above, true background "Hey JARVIS" stays out of
  scope; tap-to-talk/Siri-Shortcut/Action-Button launch is the agreed realistic design.

## What's running right now (2026-10-27)

- PR #144 (free-provider priority fix + Cloudflare image generation) is open, tested,
  ready for review — **awaiting David's merge decision**, not blocked on anything else.
- Moving to **Phase 1 (continuous memory/profile)** next, per the priority order David
  set in his own meta-prompt (memory first, before execution reliability, context,
  voice/iPhone, or Spotify) — see Phase 1 above for what's missing.
