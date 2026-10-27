import type { Brain, BrainRequest, BrainResponse } from "@/types/brain";
import type { MemoryStore } from "@/memory/MemoryStore";
import type { MemoryCategory, MemoryImportance } from "@/types/memory";
import type { EventBus } from "@/core/events/EventBus";

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
 *   - Real semantic/embedding-based conflict detection. `findNearDuplicate`
 *     below is a plain lexical (token-overlap) heuristic, nothing more.
 *   - A learned/scored confidence model. `confidence` is just whatever
 *     number the extraction prompt asks the brain to self-report.
 *   - Retrying/escalating a failed or malformed extraction call. A miss
 *     here just means this one turn didn't get backfilled — the next
 *     turn's extraction pass (or an explicit SAVE_MEMORY) can still catch
 *     the same fact.
 */

/** One fact the extraction prompt asked the brain to identify — see EXTRACTION_SYSTEM_PROMPT for the exact contract. */
interface ExtractedFact {
  key: string;
  value: string;
  category: MemoryCategory;
  importance?: MemoryImportance;
  /** 0 (weak guess) .. 1 (near-certain), self-reported by the extraction call. */
  confidence?: number;
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
 */
const EXTRACTION_SYSTEM_PROMPT = `You extract durable facts worth remembering from one exchange of a conversation between a
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
  it as a fact — if anything, extract only the corrected value.
- If nothing is worth remembering, respond with exactly: []

Respond with ONLY a JSON array (no prose, no markdown fences), each entry shaped exactly like:
{"key": "...", "value": "...", "category": "fact|preference|project|decision|action|task|temporary|uncertain", "importance": 1-5, "confidence": 0-1}`;

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
  extractAndStore(userId: string, userMessage: string, assistantReply: string): void;
}

/**
 * Real, Brain-backed implementation of `MemoryExtractorLike`. Constructed
 * once in `src/index.ts` and shared across every channel's Orchestrator
 * (terminal/web chat, phone, SMS, Telegram, voice) the same way `brain`
 * and `memoryStore` themselves are shared.
 */
export class MemoryExtractor implements MemoryExtractorLike {
  constructor(
    private readonly brain: Brain,
    private readonly memoryStore: MemoryStore,
    private readonly eventBus?: EventBus
  ) {}

  extractAndStore(userId: string, userMessage: string, assistantReply: string): void {
    // Genuinely nothing to extract from (e.g. a Fast Path tool-only reply
    // with empty text) — skip the brain call entirely rather than spend a
    // call on an exchange with no user content at all.
    if (!userMessage.trim() && !assistantReply.trim()) return;

    // Fire-and-forget: intentionally not awaited by the caller. Every
    // failure path below resolves (never rejects past this point) so there
    // is no unhandled rejection either.
    void this.run(userId, userMessage, assistantReply).catch((error: unknown) => {
      this.eventBus?.emit("memory.extraction.failed", {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async run(userId: string, userMessage: string, assistantReply: string): Promise<void> {
    const exchange = `User: ${userMessage}\n\nJARVIS: ${assistantReply}`;

    const request: BrainRequest = {
      messages: [{ role: "user", content: exchange }],
      tools: [],
      context: EXTRACTION_SYSTEM_PROMPT,
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

    this.eventBus?.emit("memory.extraction.completed", { userId, factsConsidered: parsed.length, factsStored: facts.length });
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
  }
}
