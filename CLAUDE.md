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

1. AI routing: Claude should be the real default brain (fixed in-progress — see PR from
   `claude/fix-ai-routing-default-and-gemini-provider`, which also adds Gemini as a new
   free-tier provider alongside Groq/OpenRouter/Cloudflare Workers AI). He does not want
   to pay for Claude usage long-term if a free option can do the job — the explicit goal is
   "always find the free option," so provider cost-tier/fallback logic matters a lot to him.
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

## Other David repos worth knowing about

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
