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
context). Includes the Apple Developer Program cost decision above. Needs its own research
pass on current App Intents/Live Activities APIs before any Xcode work starts.

### Phase 6 — Spotify integration (prompt 3 §7-§8)
Status: **ממתין**, lowest priority alongside Phase 5 per prompt 4 §10.

### Phase 7 — Controlled self-improvement loop (prompt 1 §6)
Status: **ממתין**, explicitly gated: never let the system change its own code,
permissions, or security mechanisms without the existing human-review pipeline (branch →
test → PR → human merge) — this is a process/discipline item, not a new subsystem; the
existing PR pipeline (used for every change in this session) already satisfies the actual
mechanism prompt 1 §6 asks for (propose → test → compare → only then adopt). What's
missing is making David's own stated loop explicit as a named practice, not new code.

## What's running right now (2026-10-27)

- Background research on three concrete open questions needed before Phases 4-6 can be
  scoped honestly: current iOS App Intents/Shortcuts/Live Activities capabilities and
  real background-execution limits; Spotify Web API's actual current auth/cost/device-
  control requirements; App Store Connect API's actual current auth/cost/build-upload
  requirements. Results will update this file's Phase 4-6 entries with verified facts,
  not assumptions.
- PR #144 (free-provider priority fix + Cloudflare image generation) is open, tested,
  ready for review — **awaiting David's merge decision**, not blocked on anything else.
