# JARVIS — notes for future Claude sessions

## About David (the project owner) — seed data for the "continuous personal profile" feature

David shared this personal background on 2026-10-26 while discussing JARVIS's planned
"continuous memory/profile" feature (see `JARVIS_ROADMAP_AUDIT.md` item #14 and
`JARVIS_COMPETITIVE_RESEARCH.md` area 1 — background memory extraction from every
conversation, not just explicit saves). Treat this as real seed data / a test case for
that feature, not necessarily something to hardcode verbatim into the product:

- Plays piano, classical style — likes Ludovico Einaudi, Chopin.
- Trains MMA / street-fighting-style martial arts — about a year in, still beginner level,
  but very into it. Also does calisthenics.
- Studies "BFA" at his school — **his own program's name for "Business and Fashion
  Academy," not the common "Bachelor of Fine Arts" meaning** — this is a real, recurring
  source of ambiguity worth flagging if it ever comes up in code or docs.
- Has many of his own GitHub repos/projects. He wants JARVIS to continuously watch them
  and pull relevant context automatically, rather than him re-explaining each project
  every time.
- Has an Apple Developer account with real shipped/in-progress apps. He wants JARVIS to
  monitor it and proactively notify him of new apps/updates, with unprompted feedback —
  this is a concrete, named use case for whatever "proactive intelligence" / notification
  feature gets built (see roadmap's Proactive Intelligence section, items 111-135).
- Overall intent: JARVIS should know his work/projects well enough to proactively surface
  relevant things ("I saw something that might interest you for your BFA coursework")
  without being asked — this is the north star for the continuous-memory work, not a
  one-off feature request.

## David's accumulated product wishlist (as of 2026-10-26, grows across sessions)

He asked to be reminded of these if he forgets, and for them to not get lost across
sessions/compaction. None of this is built yet unless a specific PR/commit is noted.

1. AI routing: Claude should be the real default brain — **merged, not in-progress**
   (corrected 2026-10-27 during the roadmap-audit re-verification pass: PR #143 "Fix
   AIRouter's free-first default and add Gemini as a free-tier provider" and PR #144
   "Prioritize Gemini over Groq for free-tier routing" are both on `main`; `GeminiBrain`
   is registered in `src/index.ts` alongside Groq/OpenRouter/Cloudflare Workers AI/Ollama).
   He does not want to pay for Claude usage long-term if a free option can do the job — the
   explicit goal is "always find the free option," so provider cost-tier/fallback logic
   matters a lot to him. Note: this entry is about free-provider *routing priority*, not
   about `ZERO_COST_MODE` itself (see #17 below) — `ZERO_COST_MODE` is a separate, stricter
   switch that must still be set explicitly on the live Fly deployment.
2. Continuous memory/personal profile that grows automatically after every message, not
   just on explicit SAVE_MEMORY decisions (see `JARVIS_ROADMAP_AUDIT.md` #14 and
   `JARVIS_COMPETITIVE_RESEARCH.md` area 1 — mem0-style background extraction is the
   recommended shape).
3. Voice-first operation: most interaction should happen by speaking, not typing.
4. Wake phrase "Hey Jarvis" (English) / "Jarvis שומע" (Hebrew) always on, ideally across
   all his devices — true always-on listening is a much bigger, separate undertaking
   (two-stage local-wake-word-then-cloud architecture — see competitive research area 2),
   distinct from today's more limited wake-phrase handling.
5. Voice-based confirmation ("מאשר"/"לא מאשר" spoken, not typed/clicked) for actions that
   need approval — `ConfirmationService` is already channel-agnostic, so this is "wire up
   a voice channel," not "build confirmation from scratch."
6. JARVIS should be able to place/manage phone calls on his behalf, not just send
   reminders via a wake-up call.
7. Always address him as "sir" (English) / "אדוני" (Hebrew) — already implemented in
   `src/core/brain/systemPrompt.ts`.
8. Full control across his 3 devices: MacBook, iMac, and phone — today only a Mac/iMac
   native Swift agent concept exists; phone control does not.
9. Live camera access on any device (Mac, iMac, phone) so he can ask things like "does
   this fit me / what do you think of this, look at what the camera sees right now" and
   get an answer automatically, without manually taking/attaching a photo each time.
10. JARVIS (or a connected agent) should be able to drive Claude Code itself in a
    terminal on his machines — to write code, run tests, build, and publish/ship apps
    (including to TestFlight/App Store Connect) on his behalf. He explicitly floated using
    the **App Store Connect API** for this, combined with full terminal/Mac access, so
    JARVIS could build and ship his iOS apps roughly the way this very Claude Code session
    builds and ships JARVIS itself. This is a large, high-privilege capability — treat it
    as its own project with real safety/permission gating (CONFIRM/DANGEROUS-tier at
    minimum), not a quick add-on.
11. Longer-term: package this as a real Xcode-built app instead of a raw terminal/CLI
    setup, so he doesn't need to operate terminals directly.
12. Identity/auth should be stable and device-bound, not token-based in a way that
    "keeps changing" (his words, from past frustration with API-token churn) — prefers
    pairing/credentials baked into the Mac/phone install itself over rotating tokens.
13. Design/UI polish is explicitly **deprioritized** — he wants real functionality first,
    design later.
14. Long-term ambition: on the order of ~1000 distinct capabilities/tools that don't
    conflict with each other. Competitive research (area 5) found this needs tool
    namespacing + retrieval-before-dispatch starting now, not at 1000 tools — JARVIS is
    already at ~67 tools, past OpenAI's own stated ~20-tools-per-request comfort guidance.
15. He explicitly does not want to build JARVIS's own backend on **Vercel** if avoidable —
    his stated reason (from discussing a separate project, "Decide") is Vercel serverless
    functions' 60-second execution timeout being too limiting. Keep this in mind if JARVIS
    hosting/architecture ever comes up — Fly.io (the current host) doesn't have this
    constraint, which is presumably part of why it was chosen originally.
16. He wants JARVIS to actually study/borrow from real existing open-source "Jarvis"-style
    assistant projects on GitHub — not just abstract patterns (already done, see
    `JARVIS_COMPETITIVE_RESEARCH.md`) but literally reviewing specific repos' code and
    potentially reusing substantial pieces outright where it saves real rebuilding effort.
    A star-ranked search (2026-10-26) surfaced real candidates by actual GitHub star count:
    `GauravSingh9356/J.A.R.V.I.S` (1.1k★), `alexylem/jarvis` (841★), `danilofalcao/jarvis`
    (625★), `Gladiator07/JARVIS` (600★), `isair/jarvis` (599★, offline voice),
    `ethanplusai/jarvis` (520★, macOS voice-first). Two of these were reviewed in depth on
    2026-10-26 (cloned and actually read, not just README-skimmed):
    - **`danilofalcao/jarvis`** — a Flask+SocketIO local web IDE with a manual model
      dropdown over 11 SDK clients (`app.py`). **Verdict: not worth adopting** — our own
      `AIRouter.ts`/`AIProviderRegistry.ts` is already categorically more sophisticated
      (cost-tier routing, vision-capability gating, circuit breaker, budget caps, fallback
      with events, escalation) vs. this repo's zero retry/fallback/cost-tracking. MIT
      licensed (reusable) but nothing here is actually better than what we have. Last
      commit 2025-01-26, stale. One minor side-note: its `workspace_manager.py` does
      simple query-relevant local file selection for prompt context — maybe worth a quick
      look only if JARVIS ever builds its own code-assistant/RAG feature, unrelated to
      voice/routing.
    - **`ethanplusai/jarvis`** — FastAPI + Chrome Web-Speech-API voice-first macOS
      assistant, brain = a persistent `claude -p` subprocess on the user's own Claude
      subscription. **Verdict: don't adopt wholesale** (custom non-commercial license —
      ideas/patterns only, not verbatim code reuse; Chrome-dependent always-listening is
      less private/free than our own on-device `agents/imac/.../WakeWordListener.swift`;
      depends on paid Fish Audio TTS with no fallback) **but its voice-scheduling design is
      genuinely worth reimplementing as our own code**: (1) a real barge-in/interruption +
      echo-rejection system (`speech.py`'s `SpeechScheduler` — token-overlap + stem-match
      heuristics so JARVIS doesn't hear/react to its own voice, and so the user can
      interrupt JARVIS mid-sentence) — this directly solves two real gaps in wishlist items
      #3-5 (voice-first, always-on wake phrase) that nothing else built so far addresses;
      (2) sentence-boundary streaming TTS (`SentenceSplitter`, ~120 lines) for lower
      perceived latency, worth porting once JARVIS has any TTS pipeline. Very actively
      maintained (last commit 2026-09-07, ~1,640 tests) and unusually well-documented/
      defensive code — no real quality red flags found reading it.
    He also mentioned seeing specific projects via Instagram videos pointing to GitHub, which
    isn't content Claude can browse directly; get the actual repo links from him directly
    when he has them, then use `add_repo` to attach the specific one(s) he wants reviewed.
17. **Absolute zero-cost guarantee on Claude — this is not a preference, it's a hard
    requirement, he's repeated it firmly multiple times.** `ZERO_COST_MODE=true` (already
    exists in `src/config/index.ts`/`AIRouter.ts`) is the real answer: when set, a paid
    provider (Claude) is NEVER called, not even as a last-resort fallback if every free
    provider fails — the request just fails instead. This should be set on the live Fly
    deployment once PR #144 (free-provider priority) merges. Don't frame Claude as "the
    default brain" to him again without immediately caveating that he's opted out of ever
    using it for cost reasons.
18. **Google Drive integration**: generate presentations, checklists, and to-do lists
    directly in his Drive, on request.
19. **Advanced proactive reminders/wake-up system** — a real upgrade over today's
    reminders + wake-up-call scheduler:
    - JARVIS should be able to *speak a reminder live* on a chosen device (or all of them)
      without placing a phone call — e.g. "Hey David, sorry to interrupt, but you have X"
      spoken directly through a device's speaker. Device must be powered on; closed/locked
      app state handling still needs the same iOS background-limits honesty as wishlist #4.
    - If he doesn't respond, JARVIS should follow up ("did you do it?") rather than firing
      once and moving on.
    - He can also set up his own "automations" where JARVIS proactively starts a
      conversation at a specific time/date with a reminder, in a tone he can tune (more
      casual vs. more professional/diplomatic).
    - **Security concern he explicitly raised**: if a device "wakes up" and starts talking
      on its own, there needs to be a way to make sure only HE can meaningfully respond to
      it — not whoever happens to be standing nearby. His proposed mechanisms, in order of
      sophistication he wants to grow toward: (a) start with some kind of shared
      code/passphrase between him and JARVIS ("code confirmed" style exchange) before it
      treats a reply as really being him; (b) longer-term, voice recognition (recognizing
      his specific voice, not just any voice saying the right words); (c) longer-term
      still, he wants to actually evolve a private "code language" between him and JARVIS
      over time — this is explicitly a direction he wants to grow into, not a one-time
      feature to build and forget.
    Research needed before building the voice-recognition piece specifically: realistic
    free/local speaker-identification options and their actual accuracy/privacy/cost
    tradeoffs for a single-user case — don't assume a passphrase and real voice biometrics
    are equally easy; they're different problems.
20. **Explicit priority ranking he confirmed (2026-10-27)**, against the "what's left"
    list given to him: context/natural conversation (#3 in that list), voice barge-in
    (#2), Drive integration (#3 in the earlier numbering — presentations/checklists), and
    real device validation of everything already built (#6, the Mac/iMac hardware test)
    are all **urgent, must-do now**. Spotify was "should do" but not urgent. **App Store
    Connect/TestFlight automation is explicitly LAST — only after everything else is built
    and actually working**, not in parallel. Design/visual polish (he's separately been
    sketching with ChatGPT — e.g. a live animated "core" that moves in sync with JARVIS's
    voice) is confirmed **explicitly deferred until after the functional core is solid**,
    then phone/desktop visual design, then TestFlight — he stated this exact ordering
    himself, unprompted, so this isn't just our own earlier guess, it's confirmed.
21. **Voice quality — he explicitly rejected building a custom voice clone**, reasoning
    (his own, and correct) that recording/training a custom voice would cost real time and
    money ("credits") for a bad tradeoff. He wants something that sounds genuinely human —
    his reference point is talking to ChatGPT's voice mode — not a "voice of an AI
    assistant" robotic feel, through a real, working TTS rather than a cloned voice. He
    mentioned using "a voice box for certain [other] voices" — **unclear exactly what tool
    this refers to** (possibly something used for his `videos-ai` narration work, or a
    specific TTS/voice-changer product) — ask him directly before assuming or building
    around it. Our own existing `agents/imac/JarvisAgent` currently just uses
    `AVSpeechSynthesisVoice`'s best-available system voice with zero pitch/style tuning
    (see `WakeWordListener.swift` `speak()`/`bestAvailableVoice()`) — macOS's own premium/
    "Enhanced"-quality system voices are free, on-device, and genuinely natural-sounding;
    picking a better one + light pitch tuning for a deeper tone is a cheap, real
    improvement worth doing before reaching for any paid cloud TTS. Separately, Twilio
    phone calls already have `TWILIO_VOICE_PITCH`/`TWILIO_VOICE_RATE` tuning — a different
    code path from the Mac agent's speech, don't conflate the two when touching "the
    voice."
22. **"Open your chat" / chat-surface access**: he wants to be able to say something like
    "open your chat" and have JARVIS actually open a real chat surface he can type/talk in
    — e.g. opening the existing Telegram bot conversation with JARVIS — on whichever
    device he's using, phone included. This is distinct from a one-off spoken reply; it's
    "give me a persistent place to keep talking to you."
23. **Deep, system-wide iPhone integration** — not just JARVIS's own reminders/calendar
    features, but genuinely hooking into iOS's own Reminders app, Calendar, and other
    system-level surfaces, plus general capabilities (weather, etc.) — his own framing:
    "like Siri, but David Intelligence instead of Apple Intelligence." This is the iPhone
    app phase (wishlist #8-11) at full scope, not a smaller subset.
24. **Specific, concrete example of the humor/tone he wants** (2026-10-27, from a demo
    video he watched): JARVIS reading his calendar should editorialize lightly on vague
    entries — e.g. an event just labeled "Busy" deserves a dry remark ("whoever titled
    that slot 'Busy' deserves a medal for descriptive precision"), not a flat readout.
    This is a specific instance of the general personality/tone work (`systemPrompt.ts`,
    see PR #148) — worth checking in real use whether the existing tone guidance already
    produces this kind of remark, or whether the system prompt needs a more concrete nudge
    toward noticing and commenting on oddities in retrieved data, not just answering it.
25. **Voice should adapt to match his own speaking style over time, respectfully** — not
    a fixed personality, but JARVIS "training itself" on his tone/vocabulary/speaking
    style through ordinary conversation (the continuous-memory extraction pipeline,
    `MemoryExtractor`, is the natural mechanism — a standing "communication style" memory
    category/preference, not a new subsystem). He was explicit that this must stay
    respectful/assistant-appropriate — mirroring his style, not literally imitating him
    or losing the "sir"/"אדוני" formality.
26. **Found a real, relevant product while browsing** (2026-10-27): **Dessa**, by Block
    (Jack Dorsey's company) — `block.xyz/dessa`, "the most authentic full-duplex speech
    model ever built," trained on real two-person human conversation audio specifically
    for sarcasm, natural pausing, breathing, and accents (shown handling an "AI
    receptionist"/"AI sales calls" use case). **This is directly relevant to his explicit
    "sound genuinely human, like ChatGPT voice mode" goal (wishlist #21)** — but it's
    waitlist-only, not a released/accessible API as of this writing. Worth periodically
    checking if it opens up, but not something to integrate today; flagging so it isn't
    forgotten, not as an action item yet.

## Status note (2026-10-27): the "Task State Machine" / "Goal Engine" roadmap gaps are now mostly closed

`JARVIS_ROADMAP_AUDIT.md` previously flagged a Task State Machine and Goal Engine as
**MISSING** — this is now stale against `main`. Before this session, `src/agent/AgentCore.ts` +
`AgentTaskStateMachine.ts` + `AgentTaskStore.ts` already implemented a real persisted task
state machine (PENDING→PLANNING→EXECUTING→VERIFYING→COMPLETED/FAILED/CANCELLED/RETRYING/
RECOVERING/WAITING, enforced transitions, cooperative cancellation wired into
`Orchestrator.requestStop`, a resumable priority queue, and goal-grouped progress via
`AgentTaskStore.getGoalProgress`) — but **nothing ever called `AgentCore.startGoal`**, so the
background queue (`agentQueueInterval`) had been running against a permanently empty table.
PR #152 (merged) closed that gap: `src/agent/GoalStore.ts` + four tools
(`CREATE_GOAL`/`CHECK_GOAL_PROGRESS`/`COMPLETE_GOAL`/`CANCEL_GOAL` in `src/tools/agent/`) give
the model a real on-ramp into the existing queue, and `src/agent/goalProgressNote.ts` surfaces
active goals/next-step into the system prompt at conversation start (same place as
`dueRemindersNote`/`staleCommitmentsNote`) so JARVIS can mention progress unprompted across
separate conversations. `CREATE_GOAL` decomposes a goal into a flat, capped (≤12) list of steps
exactly once — deliberately not a recursive/self-reprioritizing planner, as a guard against the
documented AutoGPT/BabyAGI runaway-task-list failure mode. All of this still runs through the
existing Orchestrator/PermissionService/ConfirmationService gates — no new unsupervised
execution was added. PR #151 (merged) also did a post-merge security/bug audit of PRs
#143-#149: two real defense-in-depth fixes (constant-time passphrase comparison, device-binding
on proactive-announcement replies), no exploitable issue found. `JARVIS_ROADMAP_AUDIT.md`
itself has not been re-edited to reflect this — treat its Task State Machine / Goal Engine
"MISSING" verdicts as outdated until it's refreshed (a dedicated re-verification pass against
the real codebase was kicked off 2026-10-27 — see its own PR for the corrected item-by-item
status once merged).

**Spotify is also already fully built and wired, contrary to what David was told earlier
today**: `src/spotify/SpotifyClient.ts`, `SpotifyTokenStore.ts`, and five tools
(`PlayMusicTool`/`PauseMusicTool`/`SkipTrackTool`/`GetCurrentlyPlayingTool`/`UnlinkSpotifyTool`)
are implemented and registered in `src/index.ts` behind `SPOTIFY_CLIENT_ID`/
`SPOTIFY_CLIENT_SECRET`/`JARVIS_PUBLIC_BASE_URL`. What's actually unconfirmed is only
operational: whether those env vars are set on the live Fly deployment, and whether David has
completed the one-time Spotify OAuth link. Don't tell him Spotify "isn't built" again —
check `src/index.ts`'s `spotifyEnabled` wiring and ask him to confirm the live secrets/OAuth
link instead.

## David's decisions on "what's missing" items (2026-10-27)

Responding to a list of remaining gaps he was given, he decided:
- **Spotify**: build it — see above, turned out to already be built; what remains is
  confirming/activating it (live secrets + OAuth link), not new code.
- **"Open your chat"** (wishlist #22): build it now — in progress (see PR for
  `claude/open-your-chat` branch).
- **Voice/speaking-style adaptation** (wishlist #25): confirmed, but explicitly **not now** —
  keep it recorded, revisit later.
- **Real device/hardware validation** (Mac/iMac agent): explicitly deferred until he's
  physically at the Mac **together** with this session — not something to attempt unsupervised
  before then.
- **Refreshing `JARVIS_ROADMAP_AUDIT.md`**: he didn't understand this item when first listed
  (it's a documentation/bookkeeping task, not a product feature) but said it "seems important"
  once it was explained that the doc has already been caught stale twice in one session
  (Task/Goal Engine, Spotify) — a re-verification pass was kicked off right away (see above).
- **iPhone app** (wishlist #8-11, #23): confirmed still deferred until the rest of the
  functional core is solid, per the priority ordering already recorded in wishlist #20 — but
  he added a concrete new requirement for when it's eventually built: saying "Hey Jarvis" on
  the phone should trigger a **real visual indicator appearing on-screen**, similar to how the
  newest Siri shows its orb/glow when activated — his own words were "not an animation, but
  some kind of real 'core' that appears." This is a functional wake-indicator requirement, not
  the separate ChatGPT-driven visual/icon design work he's doing independently — record it as a
  requirement for whichever phase actually builds the iPhone app's wake-word UI, not something
  to build now.

## Researched and rejected: self-hosted BitNet as a free JARVIS brain (2026-10-27)

David found `microsoft/BitNet` (1-bit LLM inference, MIT, ~41k★, actively maintained) via an
Instagram video and asked whether JARVIS should self-host it as a brain option immune to
third-party free-tier changes. Researched (not built) and the verdict was **not worth building
now, and probably not later either in its current form** — two blockers, not just one:
1. **It isn't actually free.** Fly.io has no free tier in 2026; running BitNet-b1.58-2B-4T
   alongside JARVIS's existing process needs roughly `shared-cpu-2x`/2GB (~$13.39/mo) vs.
   today's `shared-cpu-1x`/512MB (~$3.69/mo) — a real ~$10/mo new cost, i.e. trading "pay for
   Claude tokens" for "pay for Fly compute," exactly the trade-off wishlist #17's zero-cost
   mandate exists to avoid.
2. **4,096-token context window** is a plausible hard architectural blocker on its own:
   JARVIS's system prompt + ~67 tool schemas would likely consume most/all of that budget
   before the model ever sees the user's message — would need a separately-built, drastically
   cut-down tool manifest just for this one provider.
Also notable: real-world quality is "decent for a 2B model" (competitive on GSM8K/IFEval,
clearly behind on MMLU/HumanEval+) but far below Gemini/Groq/Claude for general conversation
and tool-calling reliability, and the model card documents limited non-English support — a
real concern given JARVIS's Hebrew requirements. The repo's own headline "100B model on a
single CPU" claim is a synthetic benchmark, not a real downloadable model — don't cite it as a
real capability.

The one thing confirmed *safe* in this research: David's explicit worry about a self-hosted
model's disk footprint growing or risking JARVIS's memory data is already structurally
resolved by Fly's existing architecture — the persistent volume (`/data`, all the SQLite DBs)
is fully separate from the machine's own image/filesystem (where model weights would live),
so redeploying/resizing/recreating the machine never touches memory data. No new design needed
if this is ever revisited — just a one-line discipline (keep model files off the `/data` mount).

Worth a quick re-check only if BitNet (or something similar) ships a materially larger context
window in a future release — not something to schedule as a project today.

## Added: global keyboard shortcut for "look at my screen" (2026-10-27, not yet built on a real Mac)

David wanted a keyboard trigger, in addition to saying "Hey Jarvis," for the screen-vision
feature being built concurrently (the `LOOK_AT_SCREEN` device tool + orchestrator vision wiring
— a separate piece of work, not touched here). Added `agents/imac/JarvisAgent/Sources/
JarvisAgent/Voice/GlobalHotkeyListener.swift`, registered alongside `WakeWordListener` in
`main.swift`. **Chosen shortcut: Control+Option+J** ("J" for JARVIS) — picked for being a
rare chord nothing in stock macOS or common apps binds globally (unlike Cmd-based combos,
where most real collisions live) and for using a mnemonic letter key rather than an
unmemorable function key. It's a single named constant
(`GlobalHotkeyListener.modifierFlags`/`keyCodeJ`) specifically so it's a one-line change once
David tries it for real. On trigger, it sends the exact same `voice.transcript` message
`WakeWordListener` already sends for a spoken command (via the existing
`JarvisAgentApp.sendVoiceTranscript`, reused rather than duplicated), with a fixed stand-in
phrase ("Look at my screen and tell me what you think.") in place of a live transcription —
functionally identical to speaking "Hey Jarvis, look at my screen." Uses
`NSEvent.addGlobalMonitorForEvents(matching: .keyDown)`, which needs the same Accessibility
trust this Agent already requests at launch for `ClickElementTool`/`TypeText` — no new
permission to explain to David.

**Same standing caveat as every other Swift Mac-agent feature so far: never compiled or run
on a real Mac** — no Xcode/macOS toolchain in this sandbox. Written and reviewed by hand
against `WakeWordListener.swift`'s existing conventions, not verified end to end. Revisit the
exact chord once David actually tries it on his real keyboard and can say whether Control+
Option+J collides with something else he uses.

## Architecture decision (2026-10-27): hybrid Fly + Mac split, and Claude Code via subscription not API

David proposed, and this is now the target architecture: **Fly.io stays the light, always-on
home for everything that must work regardless of whether his Mac is on** — memory (SQLite),
reminders, the Goal Engine, conversation itself when he's on his phone. **The Mac agent
(`agents/imac/JarvisAgent`) is the "strong hands"** — real local power (files, terminal,
eventually driving a real browser for narrow cases, see below) — invoked by the Fly
orchestrator over the existing WebSocket channel, and only available when the Mac is on. This
isn't a new idea so much as making explicit how wishlist #8 (full device control) and #10
(JARVIS driving Claude Code to build/ship his own apps) actually fit together with #15
(why Fly, not Vercel) and #17 (zero-cost Claude).

**Important specific insight from David**: when the Mac agent eventually drives Claude Code in
his terminal (#10), it should invoke the `claude` CLI itself — using his own Pro/Max
subscription's flat-rate billing — **never a Claude API key** (metered, pay-per-token, exactly
what wishlist #17's zero-cost mandate rules out). This is the same brain-pattern already
reviewed and partially credited in wishlist #16's `ethanplusai/jarvis` review (a persistent
`claude -p` subprocess on the user's own subscription) — there it was for voice; here it's for
real execution power without touching API billing. Still explicitly the LAST thing to build
(#10's own ordering, high-privilege, needs real CONFIRM/DANGEROUS gating) — recorded now so the
design intent isn't lost before that phase starts.

## Researched and rejected (for now): general Mac browser automation as a unifying access strategy (2026-10-27)

David's broader idea — instead of a dedicated OAuth/API integration per web service
(GitHub/Canva/Instagram), have JARVIS drive his actual Chrome browser on the Mac, reusing
sessions already logged in there — was researched and the verdict is clear: **build the
per-service integrations as already planned; do not build general browser automation as an
alternative or parallel strategy.** Reasons:
- **Technically real but the worst fit for this codebase as a default tool.** CDP-attaching to
  an already-running real Chrome profile works in principle, but conflicts with having Chrome
  already open (one-process-per-profile-directory), and CDP-driven Chrome is increasingly
  fingerprinted/blocked by exactly the sites that matter most here (Google/banking). The
  best-fit technical shape, if ever built, is a Chrome extension + native messaging to the
  Swift agent (not CDP, not AppleScript/Accessibility — that pattern, already used well by
  `ClickElementTool.swift` for native macOS apps, is markedly more fragile against real, dynamic
  web pages).
- **The real blocker is safety, not plumbing.** Unlike every tool JARVIS has today, this one's
  blast radius is "whatever's logged into that browser" — email, banking, everything — not one
  named, scoped operation. Prior art (OpenAI's own hosted computer-use docs, Browserbase/Anchor
  Browser's isolated-session model, Vercel's `agent-browser` confirm-by-category pattern) all
  converge on the same answer: real products either isolate the session entirely (never reuse
  the human's real logged-in identity) or require per-action-category confirmation with a hard
  domain allowlist enforced *before* any action reaches a permission check. If this is ever
  built: READ (navigate/extract) allowed by default and logged; CONFIRM for anything that types
  into a field or clicks non-destructively; DANGEROUS (stricter than today's DANGEROUS tools,
  must show the actual destination domain in the prompt) for any form submission or anything
  touching email/banking/payments at all; a short David-approved domain allowlist enforced at
  the agent layer, fail-closed for anything not on it.
- **This sits even later than #10 (App Store Connect), not alongside it** — #10 is scoped, has
  an official API, and only touches David's own software; general browser automation has no
  default scope boundary and is a harder safety problem. Only worth building later, narrowly,
  for a specific site that turns out to have no usable API — not as a general capability.

**Per-service verdict for the three services actually asked about:**
- **GitHub**: build a real dedicated integration (PAT or GitHub App) — matches the
  "continuously watch my repos" ask directly, nothing like this exists in the codebase yet, and
  it's a clean build. **Not built yet — next concrete thing to build when ready.**
  Not API-key-churn if built as a GitHub App rather than a personal access token, per wishlist
  #12's stable-identity preference — worth deciding which at build time.
- **Canva**: build the official Connect API integration (Design/Export/Asset/Autofill/Brand
  Template APIs — OAuth-based, matches wishlist #18-style generation asks), BUT Canva's own
  docs say Connect is for **web apps with a backend, not desktop apps** — route it through the
  existing Fly-hosted core (same pattern as `GoogleDriveClient.ts`/`SpotifyClient.ts`), never
  through the Swift Mac agent directly. **Not built yet.**
- **Instagram: already solved, confirmed in this pass — no new work needed.**
  `src/studio/StudioClient.ts` already talks to `davidpit1565/videos-ai`'s own `/api/jarvis/*`
  endpoints (bearer-secret-authenticated, not the studio's browser PIN cookie) for reading
  Instagram stats/reels and triggering the same publish action the studio's own button calls —
  which itself uses the real Instagram Graph API. This is real, already-written code, but **it
  carries its own "REQUIRES REAL VALIDATION: never exercised against the real deployed studio"
  flag** — the remaining work here is validating it against the live studio deployment (and
  confirming `JARVIS_STUDIO_SECRET` is actually configured), not building a new integration.

## Spec for later: multi-device wake-word routing (2026-10-27, not built yet)

David uses JARVIS across three devices simultaneously (iPhone, iMac, MacBook) and gave a
precise, concrete spec for how wake-word activation across them should behave once this is
actually built — recording it now so the design survives until that work starts. **This
explicitly depends on both the Mac/iMac hardware validation pass and the iPhone app existing**
(neither is done yet — this is not something to build today), and both of those are themselves
gated on doing the work together with him in front of the real devices (per his own "Real
device/hardware validation... deferred until he's physically at the Mac together with this
session" decision above). The spec:
- **Plain wake phrase ("Hey Jarvis" / "Jarvis שומע", no device named) always routes to the
  device he most recently talked to JARVIS on** — not all three devices waking/responding at
  once. This needs a server-side (Fly-hosted) "last active device" pointer per user, updated on
  every turn regardless of which device it came in on, that each device's wake-word listener
  (or the orchestrator routing its output) consults before deciding whether to actually respond.
- **Saying a wake phrase with an explicit device name, in English** — "Hey Jarvis iPhone," "Hey
  Jarvis iMac," "Hey Jarvis MacBook" — routes to that specific named device regardless of which
  one was last active, and only that device should wake/respond, not the others. This means
  each device's local wake-word listener needs to recognize both its own generic wake phrase
  and its own name-suffixed variant, and explicitly NOT respond to another device's
  name-suffixed phrase even if it's in earshot (e.g. the MacBook should ignore "Hey Jarvis
  iPhone" even if it hears it clearly).
- Net requirement: the existing per-device `WakeWordListener.swift` pattern
  (`agents/imac/JarvisAgent`) needs to (a) know its own device name/identity, (b) check a
  shared "who's last active" state before responding to a bare wake phrase, and (c) parse an
  optional trailing device-name token and only engage if it matches its own identity or there is
  none. The MacBook variant of the agent doesn't exist yet (today's Swift agent work has only
  targeted the iMac) — per David's explicit ask here, the same agent needs to run on **both**
  his iMac and his MacBook, not just one, once this phase starts.

## Researched: free/local speaker verification for wishlist #19's voice-ID tier (2026-10-27, not built)

Researched (not built) whether a real speaker-verification option exists to confirm a reply to
a JARVIS-initiated proactive announcement is actually David speaking, not just anyone saying the
right words — the second-tier security mechanism he described wanting to grow toward, beyond
the already-built passphrase (PR #146). **Verdict: not ready to build now.** Two separate
problems, not one:
1. **No off-the-shelf free product exists anymore.** The one obvious fit, Picovoice Eagle
   (free-tier, on-device, Swift-friendly), was **retired in September 2025**. Azure AI Speaker
   Recognition and Amazon Connect Voice ID were also both retired/discontinued in 2025. This
   landscape got measurably worse in the last year — not a case of an obvious tool being missed.
2. **The remaining DIY option (open-source speaker-embedding models, e.g. SpeechBrain's
   `spkrec-ecapa-voxceleb`, Apache 2.0, genuinely free, runs fully on-device/local, no cloud
   needed) is not reliably accurate for short replies like "מאשר"/"לא מאשר."** Published
   research on short-utterance speaker verification shows error rates climbing sharply as
   utterance length drops — real numbers range from single digits up past 20% error on ~1-second
   clips, even under clean lab conditions (a real iMac mic in a real room would be worse). A
   one-word yes/no reply sits squarely in this unreliable range.

Privacy is not the blocker here — the realistic model choice (SpeechBrain/pyannote-style
embeddings) runs entirely on-device, matching the existing `WakeWordListener.swift` posture of
never sending audio to the cloud. The real tradeoff is accuracy-vs-utterance-length: a longer
spoken confirmation phrase (several seconds, not one word) would land in a meaningfully more
reliable regime, but that's a real UX tradeoff David should decide on explicitly, not have
decided for him by assuming "מאשר" alone can ever be voice-verified reliably.

**If/when revisited**: the concrete next step is an offline prototype — stand up SpeechBrain's
ECAPA-TDNN model as a local sidecar process the Swift Mac agent calls over localhost, enroll
David with ~5-10 real sample recordings on his actual iMac mic, and measure real accuracy on
both his current short passphrase word and a longer alternative phrase before wiring anything
into the live agent. Store only the derived embedding (not raw audio), in a small dedicated
local store matching `ConfirmationPassphraseStore.ts`'s existing single-secret-per-user pattern,
living on the Mac rather than Fly since the whole point is the voiceprint never needs to leave
the device. The passphrase remains the right primary mechanism for now; voice verification,
once viable, should layer on top of it (closer to 2FA) rather than replace it.

## Built (2026-10-27): LOOK_AT_SCREEN (real vision on the screen) + OPEN_URL confirmed already-built

David wanted "Hey Jarvis, look at my screen — what should I do here?" to actually work —
JARVIS seeing a live screenshot and commenting on real specifics, not just saving a file and
telling him a path exists (that's what `CAPTURE_SCREENSHOT` already does, and still does,
unchanged). Built `LOOK_AT_SCREEN` (`src/tools/system/LookAtScreenTool.ts` +
`agents/imac/JarvisAgent/Sources/JarvisAgent/Tools/LookAtScreenTool.swift`, CONFIRM-tier, same
reasoning as `CAPTURE_SCREENSHOT`) as a sibling tool, not a replacement: it captures a JPEG
screenshot, downscales/recompresses it (via `sips`, shared `ScreenCaptureCore.swift` extracted
so both screenshot tools reuse the same `screencapture` subprocess logic) to comfortably fit
under Core's existing `MAX_IMAGE_BASE64_LENGTH` cap, and returns the actual image bytes instead
of a path.

The real design work was the **Vision Bridge** (`src/core/orchestrator/screenVisionBridge.ts`):
until now, an image could only enter a conversation as part of a brand-new human-sent
`UserMessage` (the web chat image-upload path) — there was no way for a TOOL CALL's result to
put a real image in front of the model within the same tool-calling turn, since
`ToolResultMessage.content` is a plain string. The bridge special-cases a successful
`LOOK_AT_SCREEN` result in `Orchestrator`'s tool loop: it extracts the image, attaches it as a
synthetic `UserMessageImage` on the very next `brain.chat()` call in the same turn (so the
model's next step genuinely sees it and correctly triggers `AIRouter`'s existing vision-provider
routing), and redacts the raw base64 out of what actually gets persisted into
`ConversationManager` — the bridge is one-shot and never written to long-term conversation
history, so a multi-MB screenshot never gets resent on every later turn. An oversized or failed
capture degrades gracefully (a normal tool-error/size-check result, no image attached) rather
than crashing or silently truncating. Covered by
`tests/core/orchestrator/screenVisionBridge.test.ts` and a new
`tests/integration/orchestrator.test.ts` describe block exercising the full bridge end-to-end
(including the oversized-payload and failed-capture paths).

Also added: `OPEN_URL`'s own system-prompt nudge — "want me to open that for you?" offered
first, then act on yes, matching David's own stated UX — in `systemPrompt.ts`. **`OPEN_URL`
itself turned out to already be fully built** (`src/tools/system/OpenUrlTool.ts` +
Swift counterpart, SAFE_ACTION-tier, http/https-only validation, already registered/tested) —
no new code needed there beyond the prompt nudge.

**Deliberate design choice, matching this repo's existing privacy posture (camera/always-on
features)**: `LOOK_AT_SCREEN` is on-demand/user-triggered only, the same CONFIRM-gated,
one-shot-per-call shape as `CAPTURE_SCREENSHOT` — there is no passive/continuous screen
watcher anywhere in this change, and none should be added without a real, separate
conversation with David first.

**Honesty check, same as every other Swift Mac-agent tool**: `LookAtScreenTool.swift` and the
`ScreenCaptureCore.swift` refactor have never been compiled or run against a real macOS
runtime — no Xcode/macOS toolchain exists in this sandbox. The TypeScript side (the tool
definition, the Vision Bridge, and the Orchestrator wiring) is real, typechecked
(`bun run typecheck`, 0 errors), and tested (`bun test`, full suite green) — only the Swift
half carries the standing "REQUIRES REAL macOS VALIDATION" caveat.

## Elaboration of wishlist #10 (2026-10-27): full scope once it's actually time to build it

David expanded on what #10 ("JARVIS drives Claude Code to build/ship his apps") should actually
cover, confirmed as an elaboration of that same already-last-priority item, not a new separate
project — still explicitly **not built now**, per his own standing priority order (#20):

- **End-to-end repo lifecycle**: not just driving an existing repo's Claude Code session, but
  JARVIS creating a brand-new GitHub repo from an idea in the first place, then running
  appropriate research agents, then building — i.e. the same kind of workflow this very
  Claude Code session already does for JARVIS itself, but JARVIS doing it for *his other app
  ideas*. The GitHub integration built 2026-10-27 (read-only PAT, `src/github/GitHubClient.ts`)
  would need real write/repo-creation scope for this — a meaningfully higher-privilege grant
  than the current read-only token, and should get its own CONFIRM/DANGEROUS-tier gating when
  built, not silently reuse the read-only integration's trust level.
- **Skills, explicitly clarified as not a separate thing to build**: David wants to be able to
  hand JARVIS "skills" the way he can hand Claude Code skills in this very session (he named
  `arena` — a heavy, multi-agent competitive skill he rarely uses because of its cost — as one
  concrete example, alongside research/design skills generally). **Important technical reality,
  explained to him and worth remembering**: skills are not a generic AI capability that can be
  bolted onto any brain — they're specifically a Claude Code harness feature (instruction
  packages loaded into a Claude session). They only become available to JARVIS at all once #10
  itself is built the way it's already architected (JARVIS's Mac agent literally invoking the
  `claude` CLI under David's own subscription/account, per the "Architecture decision" section
  above) — at that point, skills already synced to his account are automatically available to
  that Claude Code session with no additional integration work. **This is not an extra feature
  to build on top of #10 — it's something #10 already includes once it exists.** Don't treat
  "add skill support" as a separate roadmap item; it's a natural consequence of #10's own
  design, worth re-confirming in practice once #10 is actually underway, not before.

**Two more specifics from David on this same elaboration (2026-10-27):**
- **Claude Code should only be invoked when he explicitly asks for it** — not automatically
  reached for whenever JARVIS judges a task is complex enough. This is a real scoping
  constraint on #10, not just a cost concern (though it is also that, per #17): Claude Code
  access is high-privilege real-machine execution, so it should be opt-in per request, not a
  silent default escalation path JARVIS picks on its own.
- **On-demand research-agent invocation**: he wants to be able to say something like "use a
  research agent and look into X for me" and have JARVIS kick off the kind of deep research
  this very Claude Code session can do with a research-oriented skill (he named
  `agent-reach`-style multi-source research as the concrete example) — this is the same #10
  dependency as the skills point above (it only exists once JARVIS can actually drive a real
  Claude Code session under his subscription), not a separately buildable capability today.

## Approved for build: generalized "Proactive Watcher" (2026-10-27)

David confirmed he wants this built — this is the generalization of the proactive-intelligence
north star from his personal-background section ("I saw something that might interest you...
without being asked"), applied beyond GitHub specifically.

**What exists already (checked against real code, not assumed) that this should build on, not
duplicate**: `src/gmail/GmailClient.ts` (his real Gmail, on-demand read only today, no proactive
polling), `src/news/RssNewsClient.ts` (RSS news, same — on-demand only), the device-announce
proactive-speech mechanism (PR #146, `ProactiveAnnouncer`), Twilio phone-call capability, and
Telegram messaging. The GitHub proactive-surfacing work (in progress as of this note) is the
first concrete instance of the exact pattern this should generalize: poll a source on an
interval, cache what's new, decide if it's worth surfacing, surface it via the right channel.

**Design intent, not yet built**:
- A shared "watcher" abstraction — a pollable-source interface plus an urgency-to-channel
  router — that email, news-by-topic, and GitHub (once its own PR lands) can all plug into,
  rather than each source reimplementing its own polling/caching/surfacing loop from scratch.
  Build this as the generalization once GitHub's own concrete instance has landed and been
  reviewed, not in parallel with it — two independent builds of the same pattern at once would
  likely produce contradictory designs.
- **User-configurable watch targets**: e.g. "watch for news about X" as something David sets up
  himself (a topic/keyword, not JARVIS deciding on its own what's worth continuously watching),
  matching the existing GitHub pattern's explicit opt-in repo list (`GITHUB_WATCHED_REPOS`-style
  config) rather than an open-ended "watch everything" default.
- **Channel/urgency is an explicit, conservative design question — not JARVIS's unilateral
  call**: default to the quietest channel (a Telegram message with a link) unless David has
  explicitly set up a rule that a specific kind of event (e.g. "an email from a specific
  person," "this exact keyword in the news") warrants a louder channel (live device speech, or
  eventually a phone call). Never let the model itself decide in the moment that something is
  "call-worthy" with no prior rule saying so — that's a real risk of JARVIS escalating over
  something trivial in a way that's intrusive/startling, exactly the kind of thing the device-
  announce security discussion (wishlist #19) already took seriously for a different reason.
- **Phone is not a usable channel yet for a real reason, not just unbuilt-ness**: David has not
  actually connected/configured a phone number for Twilio — the code path exists but the
  channel is inert in practice today. The Watcher must treat "phone" as one of several possible
  channels that becomes available once a number is connected, not something to build around as
  if already live. Text (Telegram) and device-announce speech are the two channels that
  actually work today.

- `davidpit1565/BFA` — his school coursework repo (Business and Fashion Academy program).
- `davidpit1565/calistenics` — matches his calisthenics interest above.
- `davidpit1565/Rudder` — the app he initially called "Decide" (that was its working
  name/idea, not the repo name). A real, well-built iOS decision-intelligence app: "you
  say what you're deciding; RUDDER works out what it can, looks up what it can, asks only
  what it genuinely cannot know, and gives a recommendation with the trade-off and the
  strongest case against it." SwiftUI/SwiftData/StoreKit app + a `RudderKit` Swift package
  (dependency-free domain/decision/stability engines, 135 tests, buildable without Xcode)
  + a TypeScript `Backend/` analysis endpoint (29 tests) using `@google/genai` (Gemini) and
  `openai`. **Confirmed: `Backend/vercel.json` shows it's currently deployed on Vercel** —
  this is the concrete source of his stated "I don't want to use Vercel, 60-second function
  timeout" complaint (his AI analysis calls can run long). Worth remembering if JARVIS ever
  needs similar long-running-AI-call hosting, or if he asks for help moving this off Vercel.
- `davidpit1565/videos-ai` — his "Actually Works" channel's production system: a
  script → narration → music → render pipeline for Instagram Reels / YouTube tutorials
  about AI tools, plus `publish/instagram_publish.py`, a working script that posts a
  finished Reel via the **Instagram Graph API** (setup docs in `publish/SETUP.md`, in
  Hebrew). He said this repo and Instagram access generally matter a lot to him. **Likely
  connects to JARVIS's own existing `src/tools/studio/PublishReelTool.ts` /
  `src/studio/StudioClient.ts` integration** (seen in earlier work on this project,
  browser bookmarks named "Actually Works Studio") — worth checking whether that's the
  same underlying system before building anything new for Instagram publishing.

## GitHub auto-discovery for the proactive watcher (2026-10-27)

Added `GITHUB_WATCH_ALL_OWN_REPOS` (boolean, default false) so JARVIS can proactively watch
every repo David owns automatically instead of him listing each one in `GITHUB_WATCHED_REPOS`
by hand. `GitHubClient.listMyRepos()` calls `GET /user/repos` with `affiliation=owner` (never
every repo his token can merely read — org repos and repos he collaborates on but doesn't own
are excluded), paginated and capped at 200 total. When the flag is on, the poller re-resolves
the watch list fresh every poll cycle (not once at boot) and unions auto-discovered repos with
`GITHUB_WATCHED_REPOS`, deduped — so he can still layer on repos he doesn't own but wants
watched (e.g. ones he collaborates on) alongside auto-discovery of his own. If auto-discovery
itself fails for a cycle (rate limit, token issue), it falls back to the explicit list rather
than crashing the poller. Note this only ever affected the proactive poller
(`pollGitHubActivity.ts`) — the on-demand `GitHubClient` read/write tools (listing
commits/issues/PRs, commenting, merging) were never limited to a "watched" list in the first
place; they already work on any repo by name that `GITHUB_TOKEN` can access.

## Google Workspace broadened + YouTube added (2026-10-27)

Per David's request to connect his full Google Workspace "with all his files" and add
YouTube awareness of his own channel:
- Drive scope broadened: `drive.readonly` was added alongside the existing `drive.file`
  scope (`GoogleCalendarClient.ts`'s `GOOGLE_SCOPES`), so JARVIS can now see/search ALL of
  David's Drive files, not just ones it created itself. `drive.file` was kept, not
  replaced — `drive.readonly` is read-only and doesn't grant the create/write access
  `CreatePresentationTool`/`CreateChecklistTool` still need. A new `SEARCH_DRIVE_FILES`
  tool (`GoogleDriveClient.searchFiles`) searches by name or file content across the whole
  Drive; the existing `FIND_DRIVE_FILE` tool (title-only match) is unchanged.
- YouTube added, read-only: new `src/youtube/YouTubeClient.ts` + three tools
  (`GET_MY_YOUTUBE_CHANNEL`/`LIST_MY_YOUTUBE_VIDEOS`/`GET_YOUTUBE_VIDEO_STATS`), using the
  same shared Google OAuth consent as Calendar/Gmail/Drive (`youtube.readonly` scope, no
  separate credentials or env var). No publish/upload/comment capability.
- Any Google account already linked before this change must re-link
  (`GET /calendar/oauth/start`, choosing the same account again) to pick up the new scopes
  — same re-link precedent as the earlier Canva `design:content:read` scope bump. Gmail's
  own scopes were not touched — it already had full read + send access.

## Real formatted documents, not just checklists (2026-10-27)

Per David asking for "real documents like you prepare for me," JARVIS can now produce an
actual formatted Google Doc — a title plus one or more sections, each with an optional real
heading (`HEADING_1` named style), optional prose paragraphs, and an optional real bullet
list (`BULLET_DISC_CIRCLE_SQUARE`, not the checkbox preset `createChecklist` uses) — not just
`createChecklist`'s narrow flat checkbox list. New `GoogleDocsClient.createDocument(title,
sections, account?)` (same file/class as `createChecklist`, same shared OAuth plumbing) and a
new `CREATE_DOCUMENT` tool (`src/tools/drive/CreateDocumentTool.ts`), registered in
`src/index.ts` alongside `CREATE_CHECKLIST`/`CREATE_PRESENTATION` under the same
`calendarEnabled`-gated Drive client. Capped at 50 sections / 300 headings+paragraphs+bullets
combined (mirrors `createChecklist`'s own `MAX_ITEMS` reasoning). Implementation note: the
whole document's text is built as one concatenated string and sent as a single `insertText`,
with per-block `updateParagraphStyle`/`createParagraphBullets` style requests computed from
precomputed offsets into that one string — all in one `batchUpdate` call — rather than
inserting block-by-block, which avoids having to re-derive later blocks' indices as earlier
inserts shift the document.

## Second research pass: implementation nuances that make an agent "feel alive," not just featureful (2026-10-27)

Follow-up to `JARVIS_COMPETITIVE_RESEARCH.md` (which covered big architectural patterns). This
pass went narrower: the small, easy-to-miss behavioral/implementation details that separate an
agent that *feels* like a real personal assistant from one that technically has similar features
but reads as shallow or robotic. Scope: `WebSearch` only, multiple angles per topic, primary
sources preferred where they exist. Each finding below is checked against JARVIS's actual code
(not assumed) and marked accordingly. Confidence is stated per finding — most of this space is
practitioner blogs and vendor write-ups, not controlled studies, which is itself a finding worth
noting: rigorous research on "what makes an assistant feel personal" barely exists yet.

### 1. Memory nuances

- **Plain lexical/token-overlap duplicate detection is a known weak point, not just a JARVIS
  shortcut.** Independent benchmark work (a May-2026 arXiv paper on memory conflict resolution,
  tested against MemoryAgentBench's FactConsolidation task) found Mem0 itself — a well-funded,
  purpose-built memory product — scores only 18% on single-hop fact consolidation, and the
  temporal-knowledge-graph approach (Zep/Graphiti) scores just 7%; a much simpler
  BM25-lexical-overlap baseline actually beats both at 48%. The paper's own proposed fix is
  deterministic, timestamp-based aggregation rather than leaving conflict resolution to an LLM
  mid-retrieval. **Confidence: documented/verified** (arXiv 2606.01435, alphaxiv.org/abs/2606.01435).
  **JARVIS has it, partially**: `MemoryExtractor.findNearDuplicateKey` already does exactly this
  kind of token-overlap near-duplicate detection (threshold 0.7) before writing a background
  fact, and `MemoryStore`'s trust-rank system (`TRUST_RANK`, `getConflicts()`) already refuses a
  lower-trust write that would downgrade a higher-trust existing fact, logging the rejection
  rather than silently applying or silently dropping it. What's genuinely missing against the
  state of the art above: no timestamp-aware "this value is more recent, not just different"
  reasoning — a same-trust-rank fact overwrites unconditionally on `valueChanged`, with no check
  for whether the new statement is actually describing a *later* state of the world (e.g. "I
  moved to Berlin" after "I live in Tel Aviv" should supersede, but a contradiction from an older
  message replayed out of order could wrongly overwrite the newer truth). Worth flagging, not
  worth rebuilding now — this is a genuinely open research problem per the same paper, not a
  solved pattern JARVIS is simply missing.

- **Zep/Graphiti's "mark superseded, don't delete" pattern is the more honest middle ground
  between silent overwrite and silent data loss.** Rather than replacing a fact outright, the
  system keeps the old fact in the graph but flags it invalid/superseded, preserving history for
  audit or for cases where the "update" turns out to be wrong. **Confidence: one third-party
  write-up's description of Zep's behavior, not read from Zep's own docs — treat as likely-true,
  not verified firsthand.** **JARVIS already has the substance of this, independently arrived
  at**: `MemoryStore.memory_history` logs every old→new change (including rejected/flagged ones)
  before the upsert happens, and `getHistory(key)` / `getConflicts(key)` expose it — so nothing
  is silently lost even though the live row is overwritten. The one gap: `memory_history` entries
  aren't themselves ever surfaced back to the model in normal conversation (e.g. "you told me X
  before, now you're saying Y — which is current?") — today a contradiction is adjudicated
  entirely by trust rank with no in-conversation flag to the user when it's genuinely ambiguous
  (same trust rank, both plausible). Partially has it.

- **A real failure mode specifically in short-utterance/no-negation updates ("STALE" problem):**
  a later statement that implicitly invalidates an earlier one without using negation words (no
  "actually," no "not anymore") is measurably harder for both deterministic and LLM-based
  resolvers to catch than an explicit correction. **Confidence: documented** (same May-2026 paper
  introduces a benchmark named STALE specifically for this). **JARVIS**: lacks this entirely —
  `MemoryExtractor`'s extraction prompt instructs the model to treat an explicit, stated
  correction correctly, but has no special handling for an implicit supersession stated as a
  plain new fact with no correction language at all (e.g. user mentions a new job in passing
  without saying "I used to work at X"). Reasonable to leave as-is for now; flagging because it's
  a real, named, current research gap rather than something anyone has actually solved.

**Update (2026-10-27, same day): built a scoped fix for the one gap above that was concretely
actionable — the exact-key-only limit of the Memory Poisoning Defense, not the STALE/no-negation
problem itself.** David asked directly whether the "implicit update, different key or wording"
gap named above could be improved, and said to build it. What shipped (`src/memory/MemoryStore.ts`'s
new `flagAmbiguousUpdate()`, `src/memory/MemoryExtractor.ts`'s `buildExistingMemoriesSection`):
the extraction call — previously completely blind to existing memory, per this same research
pass's own finding above — now gets a small, bounded digest (≤30, most-recent-first, excluding
`temporary`/`task`/`action` categories) of the user's current active memories folded into its
*existing* single prompt, no second LLM call. It can then: (a) recognize a new fact as a confident
update of an existing one stated differently (e.g. "I live in Haifa" → "I just moved to Tel Aviv"
— no shared words, so the pre-existing lexical `findNearDuplicateKey` would never catch this) and
reuse that memory's exact key directly, which needs no new machinery at all — it flows straight
through `MemoryStore.save()`'s pre-existing upsert/trust-rank/`memory_history` logic, including
the Memory Poisoning Defense still correctly blocking a BACKGROUND_INFERRED "update" from
silently overwriting a higher-trust USER_STATED fact; or (b) flag a genuinely ambiguous case via
a new `ambiguousUpdateOf` field — the new fact is saved under its own key (nothing lost) and a
`flagged_conflict = 1` row is written against the candidate existing key through the exact same
`memory_history`/`getConflicts()` audit trail the trust-rank defense already uses, rather than
silently guessing either way. **Honest scope**: this does NOT solve FactConsolidation/STALE in
general — Mem0's 18%/Zep's 7% vs. the 48% lexical baseline (arXiv 2606.01435) measures a much
harder, open problem than what this addresses. This is bounded to (1) whatever's in the ≤30-item
recent-memory digest shown to that one call, not the whole store, and (2) whichever semantic
connections that one extraction model happens to notice on a given pass — there's no guarantee,
scoring, or timestamp-based reasoning behind it, just a model now actually being shown the
context it needs to make the call it was previously never even asked to make. Tests:
`tests/memory/MemoryExtractor.test.ts`'s "Scoped Fact-Consolidation" describe block (clear-update,
ambiguous-flag, trust-rank-still-applies, and unrelated-fact-unaffected baseline cases) and
`tests/memory/MemoryStore.test.ts`'s `flagAmbiguousUpdate` describe block.

- **The episodic/semantic/procedural distinction is real but the boundary is genuinely blurry in
  practice, not just a JARVIS implementation gap.** Even Endel Tulving, who originated the
  split, argued the two systems (episodic: what happened; semantic: durable facts) are
  interdependent — practitioners report the same thing operationally: deciding whether "the user
  prefers Python" should be stored as a semantic fact or as a dated episodic log entry ("on March
  4 the user said they prefer Python") is a real design choice with no clean answer, not an
  oversight. **Confidence: the Tulving point is a verifiable academic claim; the "practitioners
  report this operationally" framing is an inference from how several memory-vendor write-ups
  describe their own extraction logic, not a direct quote from any one source.**
  **JARVIS honestly only builds semantic memory today** (`MemoryStore`'s categories — fact,
  preference, project, decision, action, task, temporary, uncertain — are all "durable
  fact/state about the user," not a timestamped experience log) plus a *separate*, narrow slice
  of procedural memory (`BehaviorCorrectionStore` — "how JARVIS should act in a given tool
  context," which is precisely the procedural-memory definition multiple sources used). There is
  no true episodic memory (a chronological "what happened and when" log distinct from the
  fact store) — `search_conversation_history` searches raw conversation transcripts, which is
  closer to a flat log than a scored, reflectable episodic memory (no recency/importance/
  relevance scoring, no periodic "reflection" pass synthesizing episodes into higher-level
  insights the way Stanford's Generative Agents pattern does). This is a real, honestly-missing
  category, not partially built — worth naming explicitly since "has memory" claims can otherwise
  paper over this gap.

- **Importance/significance scoring for background-extracted facts is usually self-reported by
  the same LLM call that extracts the fact (not a separate rule-based score), and this is widely
  considered to work reasonably well** — Stanford's Generative Agents work (the most-cited
  reference point across every source checked) has the model itself rate each candidate memory's
  "poignancy" 1-10 in the same call, reasoning that language models already encode an implicit
  sense of what's mundane versus significant from training data. **Confidence: documented**
  (Generative Agents paper, widely cited secondarily). **JARVIS already does exactly this** —
  `MemoryExtractor`'s `BASE_EXTRACTION_PROMPT` asks the same extraction call to self-report both
  `importance` (1-5) and `confidence` (0-1) per fact, not a separate scoring pass. Has it.

- **Without active filtering, a persona/memory store "balloons with noise," actively hurting
  retrieval quality and cost** — one persona-memory paper's explicit framing is that users
  expect an assistant to retain career, relationships, values, and major life events, not casual
  asides, and that failing to filter those out measurably degrades retrieval. **Confidence: one
  paper's stated framing, not independently cross-verified.** **JARVIS has real filtering
  already**: the extraction prompt explicitly instructs "skip small talk, pleasantries, and
  anything with no lasting value," and `DEFAULT_QUERY_LIMIT` bounds every read path. What's
  *not* present is any measurement of whether this filtering is actually working in practice
  (no logged false-positive/noise rate) — impossible to verify without real usage data, so
  flagging as "mechanism exists, effectiveness unverified" rather than a gap to fix.

### 2. Conversational nuances

- **"One good clarifying question beats three mediocre ones," and the sharpest, most concrete
  evidence is about a very specific failure shape: a loop where the assistant asks about a new
  ambiguity every turn and the user ends up re-explaining their original intent multiple times**
  — one practitioner's claim (uncorroborated elsewhere) is that this repeated-restatement pattern
  measurably tanks satisfaction scores. A 2024 benchmark paper (ClarQ-LLM) found the opposite
  failure mode also real: skipping clarification entirely sometimes produces a *better*
  experience than asking, because the user just gets an answer faster — clarifying is not a free
  action with no cost even when it resolves genuine ambiguity. **Confidence: mixed — the
  benchmark paper's finding is documented research; the "three mediocre questions" framing and
  satisfaction-score claim is one blog's opinion, unverified.** A 2021 arXiv paper independently
  confirms the general risk ("overly inquisitive behavior" degrading UX) without giving a
  specific threshold. **JARVIS already has it, and arguably has it unusually well worked out**:
  `systemPrompt.ts`'s clarification section is explicitly built around this exact tradeoff — ask
  at most one short question, only when readings would lead to materially different outcomes,
  never ask about something "trivial or already resolved," never repeat a resolved ambiguity in
  the same thread, and (going further than anything found in this research) promote a
  *repeated* clarification pattern across separate conversations into a saved preference so the
  question stops being asked at all. This is more sophisticated than what any source described
  as current practice elsewhere.

- **Agents that silently assume, hedge, or refuse instead of asking are a documented counter-
  failure mode** — not every product err toward asking; some vendor material specifically argues
  the opposite problem (never clarifying, guessing wrong, or flatly refusing) is just as common
  and just as damaging. **Confidence: stated in practitioner/vendor material, directionally
  plausible but not independently measured.** **JARVIS has explicit guardrails against this
  too**: the system prompt's "never fabricate an answer that sounds plausible" rule and the
  separate "confirm-back" tier for garbled/misheard input (distinct from the
  multiple-readings tier) both exist specifically to avoid silently guessing. Has it.

- **No source found documents a *specific, concrete* technique for "sounding natural while being
  proactive" beyond general tone-consistency advice** — this entire sub-area (how to phrase an
  unprompted check-in so it doesn't read as a canned script) turned out to be the single weakest-
  evidenced area in this whole research pass; most "be more natural" guidance is generic and not
  specific to proactive/unprompted messages as opposed to replies. Flagging the absence itself as
  a finding: this is a real, still-open design problem for JARVIS's device-announce and
  automations features (wishlist #19), not something to assume is already solved by copying a
  pattern from elsewhere.

### 3. Tool-use nuances

- **"Filler tool calls" (calling a tool that contributes nothing, as diligence theater rather
  than to actually get information) is a named, measured failure mode, and training — not
  prompting — is what actually fixes it.** A cited 2025 Alibaba study on their "Metis" agent
  reported redundant tool invocations as high as 98% of calls in an untrained baseline, dropping
  to 2% after targeted training, with task accuracy improving alongside the drop (fewer calls,
  better results, not a tradeoff). Separately, a NeurIPS 2026 poster ("LLM Agents Already Know
  When to Call Tools") found whether a tool is actually necessary is linearly decodable from the
  model's own pre-generation internal representation (AUROC 0.89-0.96 across six models) —
  meaning models often "know" a tool call is unnecessary before making it anyway, and a cheap
  probe-and-prefill technique cut tool calls 48% with only 1.7% accuracy loss. **Confidence:
  documented research, though the 98%→2% figure is the blog's citation of the study, not
  independently re-verified against Alibaba's original paper.** **JARVIS**: has no mechanism for
  this at all — the system prompt only gives qualitative guidance ("never call a tool whose
  actual purpose doesn't match what you're looking for") and relies entirely on the underlying
  model's own judgment, with no probe, no logged filler-call rate, no training signal. Given
  JARVIS's wishlist #14 ambition (~1000 tools, already past the ~67-tool/20-tools-per-request
  comfort zone the competitive-research doc already flagged), unnecessary tool calls will likely
  get more frequent and more costly as the tool count grows — worth tracking per-conversation
  "tool called but result unused" rate as a cheap diagnostic once usage volume justifies it, not
  something to build infrastructure for today.

- **Graceful degradation on tool failure follows a fairly consistent tiered pattern across
  sources: try an equivalent alternative tool → degrade to a usable-but-weaker substitute,
  disclosed as such → escalate to a human/ask the user, with a circuit breaker cutting off a
  repeatedly-failing dependency rather than hammering it.** The one point multiple sources
  converge on explicitly: a degraded response should say so ("I couldn't check your calendar
  live, here's what I last knew") rather than silently presenting a worse answer as if it were
  the real one. **Confidence: consistent across several vendor/architecture sources (AWS's own
  agentic-AI Well-Architected guidance among them), but these are design-pattern write-ups, not
  measured outcomes.** **JARVIS has partial infrastructure for this, not the full pattern**:
  `Orchestrator.ts` already catches tool-execution errors and returns a structured message to the
  model (not a raw stack trace or silent empty result) in multiple places, and `AIRouter`'s
  provider fallback/circuit-breaker machinery already does exactly the "equivalent alternative →
  degrade → escalate" shape, but for *brain provider* failures, not for failures of JARVIS's own
  action tools (calendar, Drive, GitHub, etc.) — there's no evidence of a standing rule that a
  failed action tool must be disclosed as degraded-not-silent versus the model simply being
  trusted to phrase the error reasonably turn by turn. Worth a light pass (a shared "this result
  may be stale/incomplete, say so" convention for action-tool error returns) rather than new
  infrastructure.

- **Long-running background task UX converges on explicit state machines (running/completed/
  failed, health-check heartbeats) plus re-engagement on completion, not silence until done.**
  One concrete numeric point worth internalizing: a task with a 99%-per-minute survival
  probability still only has a ~55% chance of completing uninterrupted over 60 minutes — the
  practical implication is that any background task expected to run that long needs real
  checkpointing/progress reporting, not just a single "done" callback at the end. **Confidence:
  the 99%/55% figure is a vendor blog's own stated math (0.99^60 ≈ 0.547, which checks out
  arithmetically), not an empirically measured completion rate — treat the specific number as an
  illustration of compounding risk, not a measured JARVIS-relevant statistic.** No source
  specifically documents how Devin or Claude Code themselves solve "the user forgets what they
  asked" during a long background task — that remains an unverified gap in available public
  material, not a confirmed pattern to copy. **JARVIS already has the state-machine half of
  this**: `AgentTaskStateMachine`'s full PENDING→PLANNING→EXECUTING→VERIFYING→COMPLETED/FAILED/
  RETRYING/RECOVERING/WAITING lifecycle plus `goalProgressNote.ts` surfacing active goals back
  into the system prompt at the start of later, separate conversations is a stronger version of
  "re-engage on completion" than anything concretely documented in this research — it proactively
  reminds the user of in-flight goals unprompted, not just on-demand status checks. Has it.

### 4. Trust/reliability nuances

- **"Predictability, explainability, reversibility" is repeatedly cited as the three-part basis
  of agent trust, but no source traced this to an actual named HCI study — every mention found
  was a secondary reference with no citation.** **Confidence: directionally plausible, structurally
  consistent with other sourced findings below, but unverified as a specific research claim — flag
  it as "widely repeated practitioner framing," not settled science.**

- **"Show reasoning, not just output" is the most concretely sourced trust pattern found**: one
  guide's specific example is an agent that reschedules a meeting with no visible account of
  which conflicts it weighed or why it picked one day over another — when the choice turns out
  wrong, the user has no way to correct it efficiently because there's nothing to point to.
  Salesforce's Agentforce Observability is cited as a real shipped example: logging inputs,
  reasoning steps taken, and guardrails triggered into one traceable record. **Confidence: the
  Salesforce example is the single most concrete, attributable claim out of this whole trust
  topic (a named shipped product behavior), the rest is practitioner-blog opinion.**
  **JARVIS has meaningful infrastructure here but doesn't consistently surface it conversationally**:
  `ToolAuditLog` (referenced throughout the memory/correction code above) and
  `MemoryStore.getHistory`/`getConflicts` already keep the "why" trail server-side, and
  `BehaviorCorrectionStore` exists specifically so a past correction can change future behavior
  with an attributable reason. What's missing: no evidence the model is prompted to *proactively
  narrate* its reasoning for a judgment call in the reply itself (e.g. "I picked Thursday because
  your other two options conflicted with X") the way the Salesforce example implies — today's
  system prompt's judgment-call guidance (the goal-engine "ask before guessing" section) covers
  *asking* before a judgment call, not *narrating the reasoning* after making one that didn't need
  asking. Partially has it — worth a small systemPrompt.ts addition, not new infrastructure.

- **"Intent preview" (show the planned action before it runs, with proceed/edit/take-over
  options) is specifically called "non-negotiable" by one source for any action that's
  irreversible, financial (any amount), shares data externally, or is hard to undo** —
  essentially a stricter, UI-pattern restatement of confirm-before-acting. **Confidence:
  practitioner opinion piece, not measured, but directionally consistent with the
  CONFIRM/DANGEROUS tiering already in JARVIS's own permission model.** **JARVIS already has the
  substance of this via `ConfirmationService` and the CONFIRM/DANGEROUS tool tiers** referenced
  throughout this doc's own wishlist notes — the one gap against the "intent preview" framing
  specifically is "edit" as a third option alongside approve/deny: it's unclear from the code
  surfaced in this pass whether a user can adjust a pending confirmable action's parameters
  (e.g. "send it, but to a different time") rather than only approve-as-is or reject-and-restate.
  Not verified either way in this pass — worth a direct code check before claiming it's missing.

### 5. Proactivity nuances: done right vs. wrong

- **The Humane AI Pin and Rabbit R1 are well-documented hardware/product failures, but this
  research did NOT find evidence that proactive/unsolicited notifications specifically were the
  named cause of backlash for either** — the documented complaints are about basic reliability
  (slow, wrong, unfinished) and unclear product-market fit, not about being too proactive or
  interruptive. **Confidence: the failures themselves are well-documented (Humane sold its
  assets to HP for $116M after shutting down Pin servers in Feb 2025; Rabbit's own founder
  disclosed only ~5,000 daily active users); the specific causal link to proactivity-as-such is
  NOT established by this research** — worth not overstating this connection if it comes up
  again; these are cautionary tales about reliability and value proposition, not proactivity
  design specifically.

- **Google Now's predictive cards are the best-documented real case of proactivity triggering a
  "creepy" reaction, and the trigger was consistently topic-sensitivity, not frequency or
  timing**: the two concrete complaints found both involve *inferred-but-unstated-relationship*
  categories — a drive-time alert to a specific church (reported as "creepy" specifically because
  religion is normally an off-limits inferred category) and a general discomfort with how much
  the system clearly knew without being told. **Confidence: documented via contemporary
  (2013-2014) tech-press pieces, genuinely primary accounts, not secondary summaries.** The
  actionable, non-obvious implication: proactive surfacing's riskiest trigger for "creepy" isn't
  volume or timing, it's *demonstrating unstated inference about sensitive categories* (religion,
  relationships, health, politics) even when the inference is accurate — this is a different axis
  from the "urgency/channel" caution JARVIS's own Proactive Watcher design already recorded above.
  **JARVIS's existing design already defends against the adjacent risk (interruption/urgency)
  but not explicitly this one** — the Watcher design note above already restricts channel
  escalation to explicit user-configured rules, but has no equivalent rule about avoiding
  visible inference-display for sensitive categories specifically. Worth a one-line addition to
  the Watcher's eventual design doc when it's built, not urgent.

- **No direct evidence found of Replika/Woebot facing user backlash specifically for over-
  frequent or clingy proactive check-ins** — searches turned up only vendor help-center material
  (Replika's "report a hostile or irrelevant message" flow, Woebot's user-configured daily
  check-in time). **Confidence: absence of evidence, not evidence of absence** — real complaints
  likely exist in app-store reviews or Reddit threads that weren't reachable through this
  research's search tool; flagging as an open question rather than a settled "they got it right"
  finding. The one structurally relevant detail found: Woebot's check-in time is explicitly
  user-set, not system-chosen — a small, concrete point in favor of JARVIS's existing design
  choice (wishlist #19's automations are explicitly user-configured, not JARVIS deciding when to
  proactively start a conversation on its own).

### 6. Other notable findings

- **The research literature on "what makes an AI assistant feel like a real personal agent" is
  itself thin and mostly non-rigorous** — repeated across every search angle in this pass, the
  strongest-evidenced material was either (a) narrow, specific technical benchmarks on one
  sub-problem (memory conflict resolution, tool-call necessity), or (b) vendor/practitioner blog
  opinion with no controlled measurement. This is itself worth recording: there is no canonical
  "feels alive" literature to simply go read and implement — most of the genuinely useful,
  checkable claims in this whole pass come from narrow technical papers on adjacent problems
  (memory benchmarks, tool-call decoding), and generalizing from "a model can tell when a tool
  call is unnecessary" to "therefore the product feels alive" is this report's own inference, not
  a claim any source made directly.

- **A genuinely non-obvious cross-cutting pattern across memory, trust, and tool-use findings
  above: every area independently converged on "disclose degradation/uncertainty explicitly
  rather than silently presenting a worse answer as if it were the normal one"** — stale cached
  data, a filler tool call, a rejected lower-trust memory write, a guessed interpretation. JARVIS
  already does this in several of these specific spots (memory conflict logging, the "never
  fabricate" system-prompt rule, the confirm-back tier for garbled input) but has never stated it
  as one unified principle anywhere in `systemPrompt.ts` — e.g. there's no explicit instruction
  covering "if a tool result is partial/stale/degraded, say so in the reply, don't just answer
  from what little you got as if it were complete." Worth considering as one small, general
  addition to the system prompt rather than relying on it falling out correctly from several
  separate, narrower rules — low-risk, high-leverage if David wants a concrete next small
  improvement rather than a new feature.

## Built (2026-10-27): interim narration on Telegram, casual-confirmation understanding, translation

David asked for three related conversational UX fixes (Hebrew, paraphrased): (1) understand
casual/slang confirmations ("אני זורם," "אמן," "I'm in") as agreement, not literally; (2) translate
words/phrases on the spot and be able to say "send that to my Telegram"; (3) stop feeling slow/silent
during tool calls, especially on Telegram.

**Root cause of (3), confirmed in code**: `Orchestrator.handleUserMessage`'s tool loop
(`src/core/orchestrator/Orchestrator.ts`) records any text the model produces alongside a tool call
(e.g. "checking now") into conversation history via `addAssistantMessage`, but never delivered it to
the user until the whole loop finished — only the final reply ever reached the caller.
`TelegramGateway.ts`'s call site passed no callback at all, so a Telegram user saw nothing until every
tool iteration (potentially several, with real network calls) completed. **Fix**: a new optional
`onInterimMessage?: (text: string) => void` parameter on `handleUserMessage`, fired once per iteration
with non-empty pre-tool-call text, right when that iteration's response arrives and before its tools
run. `TelegramGateway.ts`'s call site now passes this, sending each interim narration as its own real
Telegram message immediately (fire-and-forget; a failed interim send is logged, never blocks the real
reply). Backward compatible — every other caller (web chat's `onTextDelta`, voice, AgentCore, tests)
is unaffected since the parameter is optional and additive. A new `systemPrompt.ts` addition tells the
model to say a short, natural acknowledgment before a tool call that will take real time, without
forcing one before trivial/instant actions. Tests: `tests/integration/orchestrator.test.ts` (interim
callback fires once, before tool execution, final return value unaffected) and
`tests/telegram/TelegramGateway.test.ts` (interim message sent as its own message, followed by the
final reply).

**Casual-confirmation understanding (1)**: added directly to `systemPrompt.ts` next to the existing
confirm-back section — concrete Hebrew/English examples ("אני זורם" = I'm in, "אמן" = enthusiastic
agreement, "I'm in"/"got you"/"on it" = confirmation), explicitly framed as examples of a pattern, not
an exhaustive list, falling back to the existing confirm-back behavior for genuine ambiguity.
**`BehaviorCorrectionStore` was checked and is NOT a clean fit for this**, so no code change was made
there: `MemoryExtractor.ts`'s correction-detection pass only ever looks for a correction when a
`priorAction` (a specific prior tool call) exists — it's scoped to "the user is correcting HOW I just
acted," not general terminology/phrase interpretation that can come up with no tool call involved at
all (e.g. JARVIS just misreading a casual reply in plain conversation). Forcing a terminology mapping
into that shape would mean it only ever gets learned in the narrow case where a tool call happened to
precede it. The general systemPrompt guidance above is the real fix; in the (overlapping but
different) case where a misread casual confirmation actually did follow a tool call and the user then
corrects the resulting action, the existing correction-learning pipeline already covers it with no
further code changes needed.

**Translation (4)**: no new tool/client — `systemPrompt.ts` now says explicitly to answer translation
requests directly in conversation rather than deflecting to an external translator.

**Send-to-Telegram (part of 2 and 3)**: the task spec called for a new `SEND_TELEGRAM_MESSAGE` tool,
but `src/tools/telegram/NotifyUserTool.ts` (`NOTIFY_USER`, already registered in `src/index.ts`,
SAFE_ACTION) turned out to already do exactly this — "sends a text notification to the user's phone
via Telegram, regardless of which channel this conversation is happening on," using the same
`telegramOwnerChatId` and `TelegramGateway.sendMessage` the spec described building. **No new tool was
added** to avoid a near-duplicate; `systemPrompt.ts`'s new translation note tells the model to use
`NOTIFY_USER` when asked to send a translation (or anything else) to Telegram. If a future need
genuinely diverges from `NOTIFY_USER`'s shape, build on top of it rather than starting a third
telegram-send path.

## Built (2026-10-27): the self-improvement suggestion engine

Closes out the "JARVIS proactively suggests improvements to itself" item flagged as coming after
`JARVIS_COMPETITIVE_RESEARCH.md` and the "Second research pass" section above landed. Plugs into
the existing generalized Proactive Watcher (`src/watcher/`) as a new `WatchSource` rather than a
new standalone mechanism.

**Candidate-source shape, and its explicit staleness limitation**: `src/watcher/
selfImprovementCandidates.ts` is a small, hand-curated, bounded (≤12) static list — NOT a live
"ask an LLM to brainstorm improvements" prompt, and NOT a live `CLAUDE.md` read at runtime. Both
alternatives were considered and rejected: an open-ended brainstorm has no grounding and would
produce generic, un-vetted ideas with no connection to this actual codebase, violating the
Watcher's own "not JARVIS deciding unilaterally what's worth watching" philosophy; having the
live Fly process parse this prose `CLAUDE.md` file at runtime was judged impractical (it isn't
guaranteed to ship with the deployed image, and reliably extracting "still-open items" from loose
prose is itself a fragile feature, not a simple one). Every candidate is instead grounded in a
real, already-written research pass or a real, still-open wishlist item, with concrete file/module
references. **Honest limitation, same discipline as every other note in this file**: this list
goes stale — it reflects the backlog as of 2026-10-27 and needs a human to update it by hand
(remove an item once its PR lands, add new ones as the backlog grows) the same way
`GITHUB_WATCHED_REPOS`/`NEWS_WATCH_TOPICS` need a human to update them. No live web-search
candidate source was added either — the task explicitly allowed skipping it if not clearly a good
idea, and a curated static list already gives every candidate real grounding, so an unbounded live
search felt like overbuilding for this pass. Candidates explicitly EXCLUDE anything David has
already deferred (App Store Connect/TestFlight automation, the full iPhone app, Mac/iMac hardware
validation, voice/speaking-style adaptation) — suggesting one of those back to him would contradict
his own stated sequencing and read as nagging, the opposite of this feature's "caring suggestion"
framing.

**Rotation, not repetition**: `src/watcher/selfImprovementWatchSource.ts` surfaces exactly one
candidate per poll cycle, picking whichever was suggested longest ago (never-suggested beats
everything), tracked via the cursor `WatcherStore` already persists — no new storage mechanism.
Deliberately does NOT follow the other `WatchSource`s' "first poll is baseline-only, reports
nothing" convention: that convention exists to avoid dumping an entire pre-existing backlog as a
fabricated burst of "new" activity, and this source never reports more than one item regardless,
so suppressing the first poll would only delay the feature by a full poll interval for no safety
benefit.

**Default-on, unlike every other Watcher source**: `SELF_IMPROVEMENT_WATCH_ENABLED` defaults to
`true` (an explicit `false` opts out) — a deliberate, reasoned exception to `GITHUB_WATCHED_REPOS`/
`NEWS_WATCH_TOPICS`'s opt-in-empty default. Reasoning: this source touches none of David's
external accounts or data (no new privacy/cost surface, unlike watching his email or GitHub), and
it's exactly the "tell me about this periodically, unprompted" behavior he asked to be built —
requiring him to first discover and set an env var would mean the feature silently never runs for
anyone who doesn't already know it exists. Polls weekly by default (`SELF_IMPROVEMENT_POLL_MS`,
7 days), matching his own "maybe once a week" framing — much slower than news/GitHub's 20-minute
default, since it watches a small static list, not a fast-changing external source.

**Channel: always the quietest, enforced structurally, not just by default config**. Added a new
`alwaysQuietSourceIds` field to `WatcherChannelConfig`/`routeWatcherSource`
(`src/watcher/WatcherChannelRouter.ts`) — checked before `phoneSourceIds`/`highPrioritySourceIds`,
and populated in `src/index.ts` with this source's hardcoded id, never derived from any env var.
This means no future configuration mistake (e.g. someone later widening
`WATCHER_HIGH_PRIORITY_SOURCES`) can ever escalate a self-improvement suggestion onto
device-announce or phone — it is structurally pinned to Telegram/next-conversation-note, matching
CLAUDE.md's own standing instruction that these suggestions "should NEVER be treated as
high-urgency." Surfaces via `src/watcher/selfImprovementNote.ts` at the start of the next
conversation (added to `buildContextNote.ts`, same pattern as `goalProgressNote`/
`githubActivityNote`), plus an immediate quiet Telegram push when
`WATCHER_PUSH_NOTIFICATIONS_ENABLED` is on — same dual-surfacing the news source already does.
Deliberately NOT built on the generic `composeWatcherNote` (same reasoning `githubActivityNote`
already gives for not reusing it): this source's one item needs to carry a real what/how/why
explanation, not a short flat description, both so the model can phrase a specific-sounding
suggestion and so it has real content to put in an email if David asks for one.

**Email delivery**: no new capability — `SEND_EMAIL`/`SendEmailTool` already exists and takes
arbitrary body text; `selfImprovementNote`'s full what/how/why content is already in the context
the model sees, and a one-line `systemPrompt.ts` addition tells it to use `SEND_EMAIL`/
`NOTIFY_USER` with that same content (not a shortened summary) when asked.

**Framing, never a nag**: `systemPrompt.ts` addition tells the model to offer a surfaced
suggestion once, briefly, like a thoughtful assistant noticing something — never as asking
permission to do its job, never with sales-pitch energy — and to drop it for good (never
re-raise the same one) once David has said no or shown no interest, tied to the same
never-repeat-recently-suggested rotation logic above.

Tests: `tests/watcher/selfImprovementWatchSource.test.ts` (candidate list shape, rotation/dedup,
history capping, no baseline suppression), `tests/watcher/selfImprovementNote.test.ts` (note
composition, source-id isolation), and a new case in `tests/watcher/WatcherChannelRouter.test.ts`
confirming `alwaysQuietSourceIds` overrides high-priority/phone configuration. `bun run typecheck`
(0 errors) and `bun test` (2802 pass, 0 fail) both clean.

## Proactive Watcher: both explicitly-flagged follow-ups closed out (2026-10-27)

When the generalized Proactive Watcher (`src/watcher/`) was first built, two follow-ups were
flagged as deferred-but-wanted and never done. Both are now closed:

1. **GitHub activity now gets real immediate push notifications, not just a next-conversation
   mention.** `pollGitHubActivity`'s background tick (in `src/index.ts`) now calls the same
   `WatcherNotifier`/`watcherChannelConfig` immediate-push mechanism news watching already used,
   gated the same way (`WATCHER_PUSH_NOTIFICATIONS_ENABLED`, default off; GitHub sources aren't
   high-priority by default — they go through `WATCHER_HIGH_PRIORITY_SOURCES` opt-in like any
   other source). `githubActivityNote.ts`'s next-conversation surfacing is unchanged and still
   runs independently — this is additive, so the same honest "could mention the same item via
   push AND at the start of the next conversation" redundancy news already accepted now applies
   to GitHub too. `githubActivityNote.ts` gained an exported `formatRepoActivitySummary()`
   (factored out of its existing per-repo formatter) so the push text and the context-note bullet
   share the same wording logic instead of drifting apart.
2. **Gmail is now a third Watch Source**, `src/gmail/gmailWatchSource.ts`, following the exact
   shape `src/news/newsWatchSources.ts` set as precedent: `GMAIL_WATCH_QUERIES` (comma-separated
   raw Gmail search strings, e.g. `from:someone@example.com`, `subject:invoice` — confirmed
   `GmailClient.searchMessages(query, maxResults, account?)` already accepts a raw query string
   verbatim, so no new Gmail API code was needed) is the explicit opt-in list, matching
   `GITHUB_WATCHED_REPOS`/`NEWS_WATCH_TOPICS`'s posture exactly: empty/unset leaves Gmail watching
   fully inert. Each query is its own source id (`gmail:<query>`), cursor-deduped by message id
   (same "seen set, first poll only establishes a baseline" shape as news's seen-links cursor),
   and surfaced through the same `composeWatcherNote`/`WatcherNotifier` pipeline as any other
   source — default quietest channel (Telegram) unless explicitly escalated via
   `WATCHER_HIGH_PRIORITY_SOURCES`. Per the original spec's explicit privacy caution, a surfaced
   item only ever shows sender + subject + Gmail's own short snippet (each individually capped at
   160 chars, `MAX_PREVIEW_LENGTH` in `gmailWatchSource.ts`) — it never calls
   `GmailClient.getMessageBody()`, so a full email body can never leak into a note that might
   surface in an unrelated later conversation. New config:
   `GMAIL_WATCH_QUERIES`/`JARVIS_GMAIL_WATCH_DB_PATH`/`JARVIS_GMAIL_WATCH_POLL_MS` (default 20
   minutes, same as GitHub/news), only active when a Google account is linked (`gmailClient`
   configured) — same "needs both a client and an explicit watch list" gating GitHub/news already
   have. `buildContextNote` took a new optional `gmailWatch` parameter alongside `newsWatch`,
   using its own dedicated `WatcherStore`/db file rather than merging into news's.
