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
    A first-pass web search (2026-10-26, no specific repos confirmed with him yet) turned
    up candidates worth a closer look if he confirms interest: `RehanIlyas-dev/JARVIS`
    (Python, wake-word, pluggable Gemini/OpenAI/local-Ollama backend), `llm-guy/jarvis`
    (local Ollama + LangChain wake-word assistant), `Priler/jarvis` (Rust/Tauri, fully
    offline STT/TTS/wake-word/NLU, MIT-licensed), `AFIN7/jarvis` (desktop assistant, no
    paid APIs, MIT-licensed). None of these have been cloned/reviewed in depth yet — he
    also mentioned seeing specific projects via Instagram videos pointing to GitHub, which
    isn't content Claude can browse directly; get the actual repo links from him directly
    when he has them, then use `add_repo` to attach the specific one(s) he wants reviewed.

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
