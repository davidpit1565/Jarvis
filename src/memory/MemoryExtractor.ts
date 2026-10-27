import type { Brain, BrainRequest, BrainResponse } from "@/types/brain";
import type { MemoryStore } from "@/memory/MemoryStore";
import type { MemoryCategory, MemoryImportance } from "@/types/memory";
import type { EventBus } from "@/core/events/EventBus";
import type { BehaviorCorrectionStore } from "@/behavior/BehaviorCorrectionStore";

/**
 * Continuous Memory/Profile (JARVIS_MASTER_PLAN.md Phase 1, "the top
 * priority right now"). Today, `MemoryStore` only ever gains a new fact
 * when a conversation turn happens to end with Claude deciding, in the
 * moment, to call SAVE_MEMORY — driven entirely by `systemPrompt.ts`
 * telling it "save a fact worth remembering." If the model doesn't make
 * that call (it's mid-task, the fact seems minor at the time, the system
 * prompt's guidance doesn't happen to fire), the fact is gone the moment
 * the turn ends. This module is the background pass that catches what that
 * explicit path misses: after a turn completes, it makes one small, cheap,
 * best-effort Brain call over just that one exchange and asks it to name
 * any new/updated facts worth remembering, then writes them through the
 * exact same `MemoryStore` explicit saves already use — never a second,
 * parallel memory system.
 *
 * Explicitly NOT in scope for this first pass (see JARVIS_MASTER_PLAN.md
 * Phase 1 / the PR description for the full reasoning):
 *   - `findNearDuplicateKey` below is still a plain lexical (token-overlap)
 *     heuristic for VALUES that read almost the same, nothing more.
 *   - A learned/scored confidence model. `confidence` is just whatever
 *     number the extraction prompt asks the brain to self-report.
 *   - Retrying/escalating a failed or malformed extraction call. A miss
 *     here just means this one turn didn't get backfilled — the next
 *     turn's extraction pass (or an explicit SAVE_MEMORY) can still catch
 *     the same fact.
 *
 * Scoped Fact-Consolidation (added 2026-10-27, see CLAUDE.md's dated note
 * for the research finding that motivated it — MemoryAgentBench's
 * FactConsolidation task shows even well-funded memory products scoring
 * worse than a dumb lexical baseline, so this is deliberately a bounded,
 * honest improvement, NOT a claim to solve that general problem): the
 * extraction call above used to run completely blind to existing memory —
 * it only ever saw the one raw exchange. `buildExistingMemoriesSection`
 * now hands it a small, bounded digest of the user's current active
 * memories, so the SAME call can recognize when a new fact is really an
 * existing one restated differently (e.g. "I live in Haifa" -> "I just
 * moved to Tel Aviv" — no shared words at all, so `findNearDuplicateKey`'s
 * token overlap would never catch this) and either:
 *   - reuse that memory's EXISTING key outright, when confident — this
 *     needs no new machinery at all, it flows straight through
 *     `MemoryStore.save()`'s existing upsert/trust-rank/history logic; or
 *   - flag it as an AMBIGUOUS possible update via `ambiguousUpdateOf`
 *     (`MemoryStore.flagAmbiguousUpdate`) when it isn't sure the new fact
 *     truly supersedes the old one rather than merely being related to it
 *     — never silently guessed either way.
 * This only ever catches a match against the bounded, recent slice of
 * memories actually shown to the model in that one call, and it's only as
 * good as the extraction model's own judgment on each pass — it is a real,
 * scoped improvement over pure exact-key matching, not semantic conflict
 * detection over the whole store or a general fact-consolidation solution.
 *
 * Correction Learning (same PR that added `priorAction`/`correctionStore`
 * below): this same background pass is also where behavioral corrections
 * are detected — see `types/behaviorCorrections.ts`'s doc comment for why
 * that's a conceptually distinct thing from a fact, and
 * `BehaviorCorrectionStore`'s doc comment for why it's stored separately
 * from `MemoryStore`. It shares THIS extraction call (one brain call, one
 * array response) rather than doubling the per-turn cost with a second
 * call — see EXTRACTION_SYSTEM_PROMPT's own comment on why that's safe to
 * do without confusing the two concepts.
 */

/** One fact the extraction prompt asked the brain to identify — see EXTRACTION_SYSTEM_PROMPT for the exact contract. */
interface ExtractedFact {
  key: string;
  value: string;
  category: MemoryCategory;
  importance?: MemoryImportance;
  /** 0 (weak guess) .. 1 (near-certain), self-reported by the extraction call. */
  confidence?: number;
  /**
   * Scoped Fact-Consolidation: set by the extraction call when it suspects
   * (but isn't confident enough to assert outright by just reusing the key)
   * that this fact is an update to an EXISTING memory key shown to it in
   * `buildExistingMemoriesSection` — see this module's doc comment. Never
   * set alongside a `key` that already equals this value (that would just
   * be a confident update, which doesn't need this field at all).
   */
  ambiguousUpdateOf?: string;
}

/**
 * Correction Learning: the most recent tool call JARVIS made before this
 * exchange, if any — supplied by the caller (`Orchestrator`, via
 * `findLastToolCall`) from real, already-known conversation history, never
 * guessed. Required for a correction to be detected at all (see
 * `storeCorrection`'s doc comment): without a known prior action to anchor
 * it to, there is no honest `contextKey` to file a correction under, so
 * this pass deliberately only ever looks for a BEHAVIORAL correction when
 * this is present — a general tone/preference statement with no specific
 * prior action to react to is exactly what the existing "preference"
 * fact-category already covers, not this feature's job.
 */
export interface PriorAction {
  toolName: string;
  /** The user message that triggered that tool call, for the extraction prompt's own context — not re-parsed. */
  triggeringMessage: string;
}

/** One behavioral-correction entry the extraction prompt may emit alongside (or instead of) facts — see EXTRACTION_SYSTEM_PROMPT. */
interface ExtractedCorrection {
  type: "correction";
  correction: string;
  confidence?: number;
  /** Self-reported by the extraction call when `priorAction` + a short list of standing preferences were given — see the guardrail in `storeCorrection`. */
  conflictsWithStandingPreference?: boolean;
  conflictingPreferenceText?: string;
}

const MEMORY_CATEGORIES: MemoryCategory[] = [
  "fact",
  "preference",
  "commitment",
  "temporary",
  "project",
  "decision",
  "action",
  "task",
  "uncertain",
];

/**
 * Deliberately short and narrowly scoped — this is NOT the main chat
 * system prompt (JARVIS_SYSTEM_PROMPT), it carries none of JARVIS's
 * persona/tone instructions, and the call it drives passes no tools at
 * all. The whole point is a cheap, focused call: one exchange in, one
 * small JSON array out.
 *
 * The base prompt (facts only) is always used. When `priorAction` is
 * known, `buildExtractionSystemPrompt` appends a second section asking the
 * SAME call to also look for a behavioral correction about that specific
 * action — one more array-entry shape, not a second LLM call. This is
 * deliberately NOT folded into the base prompt unconditionally: without a
 * known prior action there is no honest `contextKey` to file a correction
 * under (see `PriorAction`'s doc comment), so asking the model to guess at
 * one anyway would just invite exactly the kind of fabricated-key noise
 * `MemoryExtractor` elsewhere goes out of its way to avoid.
 */
const BASE_EXTRACTION_PROMPT = `You extract durable facts worth remembering from one exchange of a conversation between a
user and an AI assistant called JARVIS. You are a background process, not the assistant itself — the user never
sees your output directly.

Read the exchange and decide whether it contains anything genuinely worth remembering for future conversations,
using these categories:
- "fact": something true about the user or how they work/live (e.g. a hobby, a skill, a habit).
- "preference": a standing preference or instruction (e.g. "always answer in Hebrew").
- "project": an active project of theirs, or new information about one.
- "decision": a decision they (or JARVIS, on their behalf) already made, and why.
- "action": an action already taken and its verified result (not something merely proposed or planned).
- "task": an open task, problem, or next step they still need to do or JARVIS still needs to follow up on.
- "temporary": perishable information likely to go stale soon (e.g. "I'm traveling this week").
- "uncertain": something stated with real doubt, or that conflicts with something said earlier in this exchange.

Rules (follow strictly):
- Only extract what was actually said or clearly, directly implied — never invent, assume, or embellish.
- Never extract something the assistant merely offered or suggested unless the user actually agreed to it.
- Skip small talk, pleasantries, and anything with no lasting value.
- Give each fact a short, stable, dot-separated key (e.g. "user.hobby.piano", "project.jarvis.status") so a later
  update to the same fact reuses the same key instead of creating a near-duplicate.
- Set "confidence" (0 to 1) honestly — use a low value (below 0.5) for something implied rather than stated
  outright, and reserve above 0.8 for something the user stated plainly and unambiguously.
- If the user corrects, retracts, or asks to forget something, do NOT extract the old, now-superseded version of
  it as a fact — if anything, extract only the corrected value. A plain factual correction like this ("actually my
  timezone is X, not Y") is ALWAYS a fact entry (the corrected value), never a "correction"-type entry below —
  "correction"-type entries are ONLY for complaints about HOW the assistant acted, never for the user simply
  restating or fixing a piece of information about themselves or the world.
- If nothing is worth remembering, respond with exactly: []

Respond with ONLY a JSON array (no prose, no markdown fences), each fact entry shaped exactly like:
{"key": "...", "value": "...", "category": "fact|preference|project|decision|action|task|temporary|uncertain", "importance": 1-5, "confidence": 0-1, "ambiguousUpdateOf": "<existing key, ONLY for the ambiguous-update case described below>"}`;

/**
 * How many existing memories are ever shown to the extraction call for the
 * Fact-Consolidation update check — see `buildExistingMemoriesSection`. A
 * small, bounded digest (same "bounded prompt content, not a data query"
 * discipline as `MAX_PREFERENCES_FOR_CONFLICT_CHECK`/`goalProgressNote.ts`'s
 * MAX_GOALS_IN_NOTE): large enough to usually include whatever's actually
 * relevant to one fresh exchange, small enough that this never meaningfully
 * grows the cost of the one extraction call it's folded into.
 */
const MAX_EXISTING_MEMORIES_FOR_UPDATE_CHECK = 30;

/**
 * Scoped Fact-Consolidation (see this module's doc comment): appended
 * whenever the user already has at least one active memory, so the SAME
 * extraction call that pulls new facts out of the exchange can also check
 * them against a bounded, recent slice of what's already on record —
 * without this, a fact like "I just moved to Tel Aviv" has no way to know
 * an existing "user.location: lives in Haifa" memory even exists, let alone
 * that it's the same thing changing.
 */
function buildExistingMemoriesSection(existing: Array<{ key: string; value: string }>): string {
  const lines = existing.map((m) => `- ${m.key}: ${m.value}`).join("\n");
  return `

Existing memories already on record for this user (most recent first; for the update check below ONLY — do not
re-extract any of these as new facts just because they're listed here):
${lines}

Bounded update check (this only ever looks at the list above, nothing else that might exist in the user's full
memory store): for each fact you extract, consider whether it's the SAME underlying thing as one of the existing
memories above, just stated differently or changed over time (e.g. where the user lives, a job, a status, a
standing preference that changed) — not a new, separate fact that merely touches a similar topic.
- If you are CONFIDENT it's the same thing now different (e.g. "I live in Haifa" -> "I just moved to Tel Aviv"),
  reuse that EXISTING memory's exact key as this fact's own "key" instead of inventing a new one, so the update
  properly replaces the old value instead of sitting beside it as an unrelated-looking duplicate.
- If you suspect a connection to one of the existing memories above but are NOT confident it's the same fact
  changing (it could instead be new, additional information that doesn't actually replace anything), do NOT reuse
  that key — give the fact its own new key as normal, but also set "ambiguousUpdateOf" to that existing key, so it
  gets flagged for review instead of being silently merged or silently kept as an unrelated-looking duplicate.
- If a fact has no real relationship to anything listed above, extract it exactly as you normally would and leave
  "ambiguousUpdateOf" out entirely.`;
}

/**
 * Appended only when a `PriorAction` is known — see this module's doc
 * comment on why. `preferenceList` is a short, already-fetched slice of the
 * user's standing MemoryStore preferences (see `storeCorrection`'s
 * guardrail) so the SAME call can also flag a conflict, instead of a
 * second lookup/call after the fact.
 */
function buildCorrectionSection(priorAction: PriorAction, preferenceList: string[]): string {
  const preferencesBlock =
    preferenceList.length > 0
      ? `\n\nStanding preferences already on record for this user (for the conflict check below only — do not re-extract these as facts):\n${preferenceList.map((p) => `- ${p}`).join("\n")}`
      : "";

  return `

You are also checking for exactly one more thing: a BEHAVIORAL correction — the user complaining about, correcting,
or redirecting HOW the assistant just acted, not correcting a fact about themselves or the world.

The assistant's most recent action, right before this exchange, was: used the "${priorAction.toolName}" tool,
triggered by the user asking: "${priorAction.triggeringMessage}".

If — and only if — the user's message in THIS exchange reads as a correction specifically about that action (e.g.
"no, not like that", "that's not what I meant", "next time do X instead", "don't do that again", "that's wrong, it
should have been Y") — as opposed to a plain factual statement/correction, a new unrelated request, or simple
acknowledgment/thanks — include ONE additional array entry shaped exactly like:
{"type": "correction", "correction": "<a short, concrete, reusable instruction for what the assistant should do
differently next time in this situation — written as an instruction to the assistant, not a quote of the user>",
"confidence": 0-1, "conflictsWithStandingPreference": true|false, "conflictingPreferenceText": "<the exact standing
preference text it conflicts with, only if true>"}

Set "conflictsWithStandingPreference" to true only if this correction would contradict one of the standing
preferences listed above (if none are listed, this must always be false) — a single correction should never be
treated as silently overriding an explicit standing preference, so flag it instead of picking a side.${preferencesBlock}

If this exchange contains no such behavioral correction, do not include a "correction"-type entry at all.`;
}

/** Parses `text` as JSON, tolerating a markdown-fenced or prose-wrapped array the model produced despite instructions not to. */
function extractJsonArray(text: string): unknown[] | undefined {
  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    const match = trimmed.match(/\[[\s\S]*\]/);
    if (!match) return undefined;
    try {
      const parsed = JSON.parse(match[0]);
      return Array.isArray(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
}

function isValidFactShape(value: unknown): value is ExtractedFact {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.key === "string" &&
    candidate.key.trim() !== "" &&
    typeof candidate.value === "string" &&
    candidate.value.trim() !== "" &&
    typeof candidate.category === "string" &&
    MEMORY_CATEGORIES.includes(candidate.category as MemoryCategory)
  );
}

/** Correction entries are distinguished from fact entries purely by `"type": "correction"` — a fact entry never has a `type` field at all. */
function isValidCorrectionShape(value: unknown): value is ExtractedCorrection {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.type === "correction" && typeof candidate.correction === "string" && candidate.correction.trim() !== "";
}

function clampImportance(value: unknown): MemoryImportance | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  if (rounded < 1 || rounded > 5) return undefined;
  return rounded as MemoryImportance;
}

function clampConfidence(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

/**
 * Deliberately simple lexical overlap — NOT semantic similarity (see this
 * module's own doc comment on scope). Splits both strings into lowercased
 * word tokens and compares them as sets; two short facts sharing most of
 * their words ("David plays piano" vs "He plays the piano, classical
 * style") score high even though neither contains the other verbatim.
 */
function tokenOverlap(a: string, b: string): number {
  const tokenize = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9֐-׿]+/g) ?? []);
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared++;
  return shared / Math.min(setA.size, setB.size);
}

/** Above this, a new fact is treated as an update to an existing memory (same key reused) rather than a new row. */
const NEAR_DUPLICATE_THRESHOLD = 0.7;

/**
 * Basic conflict/duplicate handling (see this module's scope note: this is
 * a lexical heuristic, not semantic conflict resolution). Looks for an
 * existing active memory in the same category whose value overlaps enough
 * with the new fact's value that they're almost certainly the same
 * underlying fact under a different key — if found, returns its key so the
 * caller reuses it (an upsert, via MemoryStore's existing by-key logic)
 * instead of creating a near-duplicate row.
 */
function findNearDuplicateKey(store: MemoryStore, fact: ExtractedFact): string | undefined {
  if (store.getByKey(fact.key)) return fact.key; // exact key match — plain upsert, nothing to resolve
  // A full scan of active memories, same reasoning as `searchSemantic`'s own
  // doc comment: this is a small, personal memory store (dozens to
  // low-thousands of rows), not indexed infrastructure. A plain substring
  // search (`store.search`) isn't enough here — two near-duplicate facts
  // rarely share an exact substring (e.g. "plays piano, classical style" vs
  // "plays piano classical style"), which is exactly the case token overlap
  // below is meant to catch.
  const candidates = store.getActive().filter((record) => record.category === fact.category);
  let best: { key: string; score: number } | undefined;
  for (const candidate of candidates) {
    const score = tokenOverlap(candidate.value, fact.value);
    if (score >= NEAR_DUPLICATE_THRESHOLD && (!best || score > best.score)) {
      best = { key: candidate.key, score };
    }
  }
  return best?.key;
}

/** How long a single extraction call may run before being abandoned — see `extractAndStore`'s doc comment. */
const EXTRACTION_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`memory extraction timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export interface MemoryExtractorLike {
  /**
   * Fire-and-forget: kicks off extraction for one completed turn and
   * returns immediately without waiting for it. Never throws synchronously,
   * and any failure (brain error, timeout, malformed response) is swallowed
   * internally — see the class doc comment for why this must never affect
   * the user-facing reply.
   */
  extractAndStore(userId: string, userMessage: string, assistantReply: string, priorAction?: PriorAction): void;
}

/** How many standing preferences are ever fed into the correction conflict-check — see `buildCorrectionSection`. Small and bounded, same reasoning as `goalProgressNote`'s MAX_GOALS_IN_NOTE: this is prompt content, not a data query. */
const MAX_PREFERENCES_FOR_CONFLICT_CHECK = 15;

/**
 * Real, Brain-backed implementation of `MemoryExtractorLike`. Constructed
 * once in `src/index.ts` and shared across every channel's Orchestrator
 * (terminal/web chat, phone, SMS, Telegram, voice) the same way `brain`
 * and `memoryStore` themselves are shared. `correctionStore` is optional
 * purely so existing callers/tests that only care about fact extraction
 * don't need to construct one — when omitted, a detected correction is
 * simply never written (the fact-extraction half of this class is
 * completely unaffected either way).
 */
export class MemoryExtractor implements MemoryExtractorLike {
  constructor(
    private readonly brain: Brain,
    private readonly memoryStore: MemoryStore,
    private readonly eventBus?: EventBus,
    private readonly correctionStore?: BehaviorCorrectionStore
  ) {}

  extractAndStore(userId: string, userMessage: string, assistantReply: string, priorAction?: PriorAction): void {
    // Genuinely nothing to extract from (e.g. a Fast Path tool-only reply
    // with empty text) — skip the brain call entirely rather than spend a
    // call on an exchange with no user content at all.
    if (!userMessage.trim() && !assistantReply.trim()) return;

    // Fire-and-forget: intentionally not awaited by the caller. Every
    // failure path below resolves (never rejects past this point) so there
    // is no unhandled rejection either.
    void this.run(userId, userMessage, assistantReply, priorAction).catch((error: unknown) => {
      this.eventBus?.emit("memory.extraction.failed", {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async run(userId: string, userMessage: string, assistantReply: string, priorAction?: PriorAction): Promise<void> {
    const exchange = `User: ${userMessage}\n\nJARVIS: ${assistantReply}`;

    // One local read, reused below for both the Fact-Consolidation digest
    // (always) and the correction conflict-check's preference list (only
    // when priorAction is known) — no extra store round-trip either way.
    const activeMemories = this.memoryStore.getActive();

    // Only fetched/built when there's a prior action to possibly correct —
    // see `buildCorrectionSection`'s doc comment for why this whole section
    // is conditional rather than always appended.
    const preferenceList = priorAction
      ? activeMemories.filter((record) => record.category === "preference").slice(0, MAX_PREFERENCES_FOR_CONFLICT_CHECK).map((record) => record.value)
      : [];

    // Fact-Consolidation digest: excludes categories that are inherently
    // short-lived/one-off ("temporary", "task", "action") and therefore not
    // the kind of durable, evolving fact this update check is for — an open
    // task or a one-off completed action isn't "the same thing, changed
    // over time" the way a location/job/preference is.
    const existingMemories: Array<{ key: string; value: string }> = activeMemories
      .filter((record) => record.category !== "temporary" && record.category !== "task" && record.category !== "action")
      .slice(0, MAX_EXISTING_MEMORIES_FOR_UPDATE_CHECK)
      .map((record) => ({ key: record.key, value: record.value }));

    const systemPrompt =
      BASE_EXTRACTION_PROMPT +
      (existingMemories.length > 0 ? buildExistingMemoriesSection(existingMemories) : "") +
      (priorAction ? buildCorrectionSection(priorAction, preferenceList) : "");

    const request: BrainRequest = {
      messages: [{ role: "user", content: exchange }],
      tools: [],
      context: systemPrompt,
      // Deliberately no `runId`: this is a background, best-effort pass
      // outside any one user-facing turn's per-run cost ceiling, but it
      // still goes through the exact same Brain (AIRouter) instance as
      // every chat call, so ZERO_COST_MODE, the daily/monthly budget caps,
      // and the free-provider-first routing all apply to it automatically
      // — nothing here bypasses that machinery.
      taskType: "memory-extraction",
    };

    let response: BrainResponse;
    try {
      response = await withTimeout(this.brain.chat(request), EXTRACTION_TIMEOUT_MS);
    } catch (error) {
      // A paid-provider refusal under ZERO_COST_MODE, a timeout, a network
      // error, whatever — extraction is best-effort by design, so this
      // never throws or retries. Still emitted as an event (not silently
      // dropped) purely for observability — nothing downstream treats it as
      // an error condition that needs handling.
      this.eventBus?.emit("memory.extraction.failed", {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const parsed = extractJsonArray(response.text);
    if (!parsed) return;

    const facts = parsed.filter(isValidFactShape);
    for (const fact of facts) {
      this.storeFact(fact);
    }

    const corrections = priorAction ? parsed.filter(isValidCorrectionShape) : [];
    for (const correction of corrections) {
      this.storeCorrection(correction, priorAction!, userMessage);
    }

    this.eventBus?.emit("memory.extraction.completed", {
      userId,
      factsConsidered: parsed.length,
      factsStored: facts.length,
      correctionsStored: corrections.length,
    });
  }

  /**
   * Writes a detected behavioral correction to `BehaviorCorrectionStore`,
   * keyed by `priorAction.toolName` (a real, already-known fact — never
   * something the extraction model invented, see `PriorAction`'s doc
   * comment). Guardrail: a correction the model flagged as conflicting with
   * a standing preference is still stored (so it isn't lost — see this
   * module's class doc comment on the general "best-effort, don't drop
   * silently" philosophy), but marked `flaggedPreferenceConflict` so
   * `correctionNote.ts` always surfaces it with an explicit caveat instead
   * of presenting it as settled guidance that could silently override an
   * explicit standing preference.
   */
  private storeCorrection(correction: ExtractedCorrection, priorAction: PriorAction, userMessage: string): void {
    if (!this.correctionStore) return;

    this.correctionStore.add({
      contextKey: priorAction.toolName,
      correction: correction.correction,
      originalAction: priorAction.toolName,
      triggeringMessage: userMessage,
      confidence: clampConfidence(correction.confidence) ?? null,
      flaggedPreferenceConflict: correction.conflictsWithStandingPreference === true,
      conflictingPreference:
        correction.conflictsWithStandingPreference === true && typeof correction.conflictingPreferenceText === "string"
          ? correction.conflictingPreferenceText
          : null,
    });

    this.eventBus?.emit("behaviorCorrection.stored", {
      contextKey: priorAction.toolName,
      flaggedPreferenceConflict: correction.conflictsWithStandingPreference === true,
    });
  }

  private storeFact(fact: ExtractedFact): void {
    // Respect explicit user deletions/corrections (see MemoryStore.wasDeleted's
    // doc comment): if the user asked to forget this exact key, the
    // background pass must never resurrect it just because the raw
    // conversation text it's reading still mentions the old fact. An
    // explicit SAVE_MEMORY/DELETE_MEMORY call is always what clears this,
    // never another background-extracted guess.
    if (this.memoryStore.wasDeleted(fact.key)) {
      this.eventBus?.emit("memory.extraction.skippedDeleted", { key: fact.key });
      return;
    }

    // Basic conflict/duplicate handling: reuse an existing key under the
    // same category if this looks like the same fact restated, so this
    // becomes an upsert instead of a near-duplicate new row. See
    // findNearDuplicateKey's own doc comment for the real scope (lexical
    // overlap, not semantic).
    const key = findNearDuplicateKey(this.memoryStore, fact) ?? fact.key;
    if (this.memoryStore.wasDeleted(key)) return; // the resolved key itself may be the one that was deleted

    const result = this.memoryStore.save({
      key,
      value: fact.value,
      category: fact.category,
      importance: clampImportance(fact.importance),
      confidence: clampConfidence(fact.confidence) ?? null,
      // Always BACKGROUND_INFERRED — see MemoryTrust's own doc comment.
      // The Memory Poisoning Defense this already gets from MemoryStore's
      // trust-rank check means this can never silently overwrite a
      // higher-trust existing memory (USER_STATED/SYSTEM_DERIVED/
      // MODEL_INFERRED) for the same key; only ever an equal-or-lower one.
      source: "BACKGROUND_INFERRED",
    });

    this.eventBus?.emit("memory.extraction.wrote", { key: result.key, category: fact.category, applied: !result.conflict });

    // Scoped Fact-Consolidation (see module doc comment and
    // `buildExistingMemoriesSection`): the extraction call flagged this fact
    // as POSSIBLY related to an existing memory it wasn't confident enough
    // to treat as a straight update. A confident update already reused the
    // existing key directly (handled above by `save()`'s own upsert logic,
    // no special-casing needed) — this only ever fires for the genuinely
    // ambiguous case, and never touches the candidate key's own record.
    const ambiguousKey = typeof fact.ambiguousUpdateOf === "string" ? fact.ambiguousUpdateOf.trim() : "";
    if (ambiguousKey && ambiguousKey.toLowerCase() !== result.key.toLowerCase()) {
      this.memoryStore.flagAmbiguousUpdate(ambiguousKey, result.key, fact.value, "BACKGROUND_INFERRED");
      this.eventBus?.emit("memory.extraction.ambiguousUpdateFlagged", { candidateKey: ambiguousKey, newKey: result.key });
    }
  }
}
