/**
 * A curated, bounded list of real, still-open improvement ideas for JARVIS
 * itself — the candidate pool `selfImprovementWatchSource.ts` draws one from
 * per poll cycle.
 *
 * **Why a static in-repo list, not a live "ask an LLM to brainstorm
 * improvements" prompt or a live CLAUDE.md read:** the task that introduced
 * this file considered both alternatives and rejected them:
 * - An open-ended brainstorm prompt with no grounding would produce generic,
 *   un-vetted suggestions ("add more tests," "improve error handling") with
 *   no connection to JARVIS's actual architecture or David's actual stated
 *   priorities — exactly what `CLAUDE.md`'s Proactive Watcher philosophy
 *   warns against ("not JARVIS deciding unilaterally what's worth
 *   watching"). Every candidate below is instead grounded in a real,
 *   already-written research pass (`JARVIS_COMPETITIVE_RESEARCH.md`,
 *   `CLAUDE.md`'s "Second research pass" section) or a real, still-open item
 *   from David's own recorded wishlist — never invented fresh by this file.
 * - Having the running Fly process read `CLAUDE.md` live at poll time was
 *   considered and rejected as impractical for a deployed server: `CLAUDE.md`
 *   is a repo file tracked for *this* development session, not an artifact
 *   shipped with (or guaranteed to exist next to) the deployed Fly image,
 *   and parsing a loosely-structured prose doc at runtime to extract
 *   "still-open items" reliably is itself a non-trivial, fragile feature —
 *   far more complexity than this suggestion engine warrants.
 *
 * **Known, explicit limitation of this shape (same honesty discipline as
 * everything else in this codebase): this list goes stale.** It reflects
 * CLAUDE.md's backlog as of 2026-10-27 and will NOT automatically pick up
 * new wishlist items, nor automatically drop an item once it's actually
 * built — a human maintainer must update it by hand (remove a candidate
 * once its PR lands, add new ones as CLAUDE.md accumulates them) the same
 * way `GITHUB_WATCHED_REPOS`/`NEWS_WATCH_TOPICS` need a human to update
 * their env vars when David's actual watch targets change. There is no
 * code-level guard against this going stale; it relies on whoever next
 * works on this file checking it against CLAUDE.md's current state.
 *
 * **Deliberately excluded:** items David has already explicitly deferred
 * ("not now," "last priority," "after the functional core is solid") are
 * NOT included here even though they're real, documented gaps — e.g. App
 * Store Connect/TestFlight automation (wishlist #10, explicitly last),
 * the full iPhone app (wishlist #8-11/#23, explicitly deferred), Mac/iMac
 * hardware validation (explicitly gated on being physically together), and
 * voice/speaking-style adaptation (wishlist #25, "confirmed, but explicitly
 * not now"). Surfacing one of those as an unprompted "you should build this"
 * suggestion would contradict David's own stated sequencing and read as
 * nagging about a decision he's already made — the opposite of the "caring
 * suggestion, never a demand" framing this feature is built around. Only
 * genuinely open, not-yet-decided-against items are candidates here.
 *
 * Kept bounded (≤12, matching `CREATE_GOAL`'s own "flat, capped list"
 * discipline elsewhere in this codebase) — this is a slow-moving, hand-
 * curated list, not something meant to grow without limit.
 */
export interface SelfImprovementCandidate {
  /** Stable id — used only for dedup/rotation tracking in the watch source's cursor, never shown to the user. */
  id: string;
  /** Short, human-readable name for the idea. */
  title: string;
  /** What the feature/improvement actually is, in plain terms. */
  whatItIs: string;
  /** A concrete sketch of how it could be built, grounded in real file/module names from this actual codebase where relevant. */
  howToImplement: string;
  /** Why this might matter to David specifically, not a generic "this would be nice" justification. */
  whyItMattersToDavid: string;
}

export const SELF_IMPROVEMENT_CANDIDATES: SelfImprovementCandidate[] = [
  {
    id: "voice-barge-in-echo-rejection",
    title: "Let David interrupt JARVIS mid-sentence without it reacting to its own voice",
    whatItIs:
      "A real barge-in/interruption system for voice: the ability to interrupt JARVIS while it's speaking, plus " +
      "echo-rejection so JARVIS doesn't hear and react to its own TTS output as if David had said something.",
    howToImplement:
      "Port the design (not the code — different license) already reviewed from ethanplusai/jarvis's speech.py " +
      "SpeechScheduler: a token-overlap + stem-match heuristic that compares incoming audio/transcript against " +
      "what JARVIS is currently speaking, so it can tell 'this is my own voice coming back through the mic' apart " +
      "from 'David is actually talking.' Would live alongside " +
      "agents/imac/JarvisAgent/Sources/JarvisAgent/Voice/WakeWordListener.swift, as a new component gating when " +
      "the listener treats incoming audio as a real interruption versus ignorable echo.",
    whyItMattersToDavid:
      "He ranked voice barge-in as one of the explicitly 'urgent, must-do now' items (wishlist #20), and it's one " +
      "of the few voice-first gaps (wishlist #3-5) with a concrete, already-reviewed design to build from rather " +
      "than starting from a blank page.",
  },
  {
    id: "sentence-boundary-streaming-tts",
    title: "Start speaking a reply before the whole thing has finished generating",
    whatItIs:
      "Sentence-boundary streaming TTS: split a response into sentences as they're generated and start speaking " +
      "the first one immediately, instead of waiting for the full reply before any audio plays — lowers perceived " +
      "latency on longer spoken answers.",
    howToImplement:
      "Port the design of ethanplusai/jarvis's SentenceSplitter (~120 lines, reviewed 2026-10-26) once JARVIS has " +
      "any real TTS pipeline wired up on the Mac agent side — it would sit between wherever JARVIS's reply text " +
      "streams out of the Orchestrator and whatever speaks it (today, WakeWordListener.swift's speak()).",
    whyItMattersToDavid:
      "Directly serves the 'voice-first operation' goal (wishlist #3) — a reply that starts talking a beat sooner " +
      "reads as noticeably more responsive in actual use, not just a benchmark number.",
  },
  {
    id: "mac-voice-quality-tuning",
    title: "Pick a better system voice and tune its pitch, before reaching for paid cloud TTS",
    whatItIs:
      "Swap WakeWordListener.swift's bestAvailableVoice()/speak() off whatever default AVSpeechSynthesisVoice it " +
      "currently picks and onto one of macOS's free, on-device 'Enhanced'/premium-quality system voices, with a " +
      "small pitch adjustment for a deeper, less robotic tone.",
    howToImplement:
      "A scoped, cheap change entirely inside agents/imac/JarvisAgent/Sources/JarvisAgent/Voice/WakeWordListener.swift " +
      "— enumerate AVSpeechSynthesisVoice.speechVoices() for the highest available quality tier for David's chosen " +
      "language/accent, and set a non-default pitchMultiplier on the AVSpeechUtterance. No new dependency, no cost.",
    whyItMattersToDavid:
      "He explicitly rejected a custom voice clone as a bad time/money tradeoff (wishlist #21) but does want " +
      "something that sounds less like 'an AI assistant' — this is the cheapest real step in that direction, and " +
      "CLAUDE.md already flagged it as worth doing before any paid cloud TTS.",
  },
  {
    id: "tool-namespacing",
    title: "Start namespacing tool names now, while it's nearly free",
    whatItIs:
      "Rename registered tools to a consistent domain.action convention (e.g. calendar.create_event, " +
      "device.mac.open_app) instead of today's flat, ad hoc names.",
    howToImplement:
      "A registry-level naming convention change in src/types/tools.ts / src/tools/registry/ToolRegistry.ts — " +
      "ideally done as aliasing (register under both the old and new name for one deploy cycle) rather than a " +
      "hard rename, so nothing calling a tool by its old name breaks mid-rollout.",
    whyItMattersToDavid:
      "JARVIS_COMPETITIVE_RESEARCH.md's area 5 names this the single cheapest, highest-leverage prerequisite for " +
      "David's own ~1000-tool ambition (wishlist #14) — JARVIS is already past OpenAI's own ~20-tools-per-request " +
      "comfort guidance at ~67 tools, and this gets more expensive to retrofit the longer it's put off.",
  },
  {
    id: "retrieval-before-dispatch-stub",
    title: "Stub a 'find the right tool' step before the tool list outgrows one request",
    whatItIs:
      "A single meta-tool (e.g. FIND_TOOL) that can semantically search the tool registry and return a relevant " +
      "subset, as a first step toward not sending all ~67+ tool schemas to the model on every single turn.",
    howToImplement:
      "A LangGraph-bigtool-style stub in src/tools/registry/ToolRegistry.ts: keep the full registry as the source " +
      "of truth, add one retrieval tool backed by simple keyword/embedding matching over each tool's name + " +
      "description, and only wire it in behind a feature flag so it's a no-op today below the current tool count.",
    whyItMattersToDavid:
      "Same ~1000-tool ambition as tool-namespacing above (wishlist #14) — JARVIS_COMPETITIVE_RESEARCH.md's area 5 " +
      "explicitly recommends starting this well before the tool count actually becomes a problem, not after.",
  },
  {
    id: "degraded-result-disclosure-prompt",
    title: "Have JARVIS say so when a tool result is stale, partial, or degraded",
    whatItIs:
      "A small systemPrompt.ts addition instructing the model to explicitly flag when it's answering from a " +
      "partial, cached, or degraded tool result ('I couldn't check your calendar live, here's what I last knew') " +
      "rather than presenting a weaker answer as if it were complete.",
    howToImplement:
      "One additive paragraph in src/core/brain/systemPrompt.ts, next to the existing 'never fabricate an answer " +
      "that sounds plausible' guidance — no new infrastructure, since the underlying error-handling already exists " +
      "in Orchestrator.ts's tool-call error paths.",
    whyItMattersToDavid:
      "CLAUDE.md's own second research pass flagged this as a cross-cutting pattern every trust/reliability source " +
      "independently converged on, and noted JARVIS already does the substance of it in several specific spots but " +
      "has never stated it once as a general rule — a low-risk, concrete next small improvement.",
  },
  {
    id: "proactive-reasoning-narration-prompt",
    title: "Have JARVIS briefly explain a judgment call it made, not just the outcome",
    whatItIs:
      "A systemPrompt.ts nudge so that when JARVIS makes a non-obvious judgment call without needing to ask first " +
      "(e.g. picking one day over another when rescheduling), it briefly says why, so David has something concrete " +
      "to correct if the call was wrong.",
    howToImplement:
      "Pairs naturally with the existing 'ask before guessing' system-prompt section in src/core/brain/systemPrompt.ts " +
      "— add a short companion rule for the case where it didn't need to ask: narrate the one-line reasoning after " +
      "the fact instead of only the result.",
    whyItMattersToDavid:
      "CLAUDE.md's trust/reliability research found this the most concretely sourced trust pattern of that whole " +
      "section (a cited Salesforce Agentforce example) and noted JARVIS already logs the 'why' server-side via " +
      "ToolAuditLog but doesn't yet say it out loud to David.",
  },
  {
    id: "filler-tool-call-diagnostic",
    title: "Track how often a tool gets called but its result goes unused",
    whatItIs:
      "A lightweight diagnostic counting 'tool called, but its result never actually shows up in the final answer' " +
      "as a cheap proxy for unnecessary/filler tool calls, logged for later review rather than acted on " +
      "automatically.",
    howToImplement:
      "A small addition to the existing ToolAuditLog write path (wherever Orchestrator.ts already records a tool " +
      "call's result) — compare the result against the final reply text as a rough heuristic, log a flag, no " +
      "behavior change yet.",
    whyItMattersToDavid:
      "CLAUDE.md's research pass cites a real study (Alibaba's Metis) finding filler tool calls as high as 98% of " +
      "calls in an untrained baseline — JARVIS has no visibility into this at all today, and David's own ~1000-tool " +
      "ambition (wishlist #14) will make this more likely to matter, not less, as the registry grows.",
  },
  {
    id: "memory-conflict-surfacing-to-user",
    title: "Ask David which memory is current when a conflict is genuinely ambiguous",
    whatItIs:
      "When MemoryStore flags an ambiguous conflict (same trust rank, both plausible — already tracked via " +
      "flagAmbiguousUpdate()/getConflicts()) surface it back to David in conversation ('you told me X before, now " +
      "Y — which is current?') instead of only logging it server-side with no visible resolution.",
    howToImplement:
      "A read of MemoryStore.getConflicts() at the start of a relevant conversation turn (same shape as " +
      "goalProgressNote.ts/correctionNote.ts's existing bounded context-note pattern in src/core/buildContextNote.ts), " +
      "surfaced only when there's an unresolved flagged conflict, not on every turn.",
    whyItMattersToDavid:
      "CLAUDE.md's memory research explicitly names this as the one real gap in an otherwise solid Memory Poisoning " +
      "Defense: ambiguous conflicts are already detected and logged, just never actually asked about — a small, " +
      "concrete close of a real, already-identified gap.",
  },
  {
    id: "confirmation-edit-option",
    title: "Let a pending confirmation be adjusted, not just approved or rejected",
    whatItIs:
      "A third option on a pending CONFIRM-tier action — 'send it, but to a different time' — alongside today's " +
      "approve-as-is or reject-and-restate, matching the 'intent preview' pattern of approve/edit/take-over.",
    howToImplement:
      "Would need a real look at ConfirmationService first to confirm whether this is actually missing (CLAUDE.md's " +
      "own research pass flagged this as 'not verified either way, worth a direct code check' before claiming it's " +
      "a gap) — if confirmed missing, the natural extension point is wherever ConfirmationService resolves a " +
      "pending confirmation's user reply today.",
    whyItMattersToDavid:
      "He relies on CONFIRM/DANGEROUS-tier confirmations for anything sensitive (wishlist #10's whole safety model " +
      "is built on this) — a reject-and-restate-only flow means a small correction costs a whole extra round trip.",
  },
  {
    id: "canva-connect-integration",
    title: "Build the Canva Connect API integration David already approved",
    whatItIs:
      "A real Canva integration (Design/Export/Asset/Autofill/Brand Template APIs, OAuth-based) so JARVIS can " +
      "generate designs on request the same way it already does for Drive presentations/checklists.",
    howToImplement:
      "Route it through the existing Fly-hosted core, the same pattern as src/calendar/GoogleCalendarClient.ts / " +
      "src/spotify/SpotifyClient.ts — never through the Swift Mac agent directly, since Canva's own docs say " +
      "Connect is for web apps with a backend, not desktop apps (already researched and recorded in CLAUDE.md).",
    whyItMattersToDavid:
      "CLAUDE.md already records this as a decided 'build it' with a researched approach — it's real, scoped, " +
      "unbuilt work that matches his existing wishlist #18-style generation asks, not a new idea.",
  },
];
