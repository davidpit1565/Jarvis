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
