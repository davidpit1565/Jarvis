/**
 * Continuous Memory/Profile (Phase 1 of JARVIS_MASTER_PLAN.md): extends the
 * original "fact" | "preference" | "commitment" | "temporary" set with the
 * remaining categories from David's 8-category spec (see CLAUDE.md /
 * JARVIS_MASTER_PLAN.md Phase 1) that had no home in the original set:
 *
 *   1. standing preferences/instructions -> "preference" (existing)
 *   2. facts about him and how he works  -> "fact" (existing)
 *   3. active projects and their history -> "project" (new)
 *   4. decisions already made and why    -> "decision" (new)
 *   5. actions already taken + results   -> "action" (new)
 *   6. open tasks/problems/next steps    -> "task" (new)
 *   7. temporary/perishable information  -> "temporary" (existing)
 *   8. uncertain or conflicting facts    -> "uncertain" (new)
 *
 * "commitment" (a promise/follow-up) is kept as-is for backward
 * compatibility with existing rows/tools, even though JARVIS also has a
 * separate, purpose-built `CommitmentStore` for actual tracked promises —
 * this category predates that store and nothing currently migrates old
 * rows off it, so removing it would silently reclassify existing data.
 */
export type MemoryCategory =
  | "fact"
  | "preference"
  | "commitment"
  | "temporary"
  | "project"
  | "decision"
  | "action"
  | "task"
  | "uncertain";

/** 1 (trivial) .. 5 (critical) — coarse enough to be useful without pretending to be a real ranking model. */
export type MemoryImportance = 1 | 2 | 3 | 4 | 5;

/**
 * Memory Trust System (extends the category/importance/expiration layer
 * above). Where a memory's value actually came from — not a quality/
 * confidence score, just provenance:
 *
 *   - USER_STATED: the person said this themselves, explicitly, in
 *     conversation. Highest trust — this is ground truth.
 *   - SYSTEM_DERIVED: computed/observed by JARVIS's own code from a
 *     reliable source (e.g. read back from a calendar/reminder system JARVIS
 *     itself manages), not asserted by the user or guessed by the model.
 *   - MODEL_INFERRED: the model decided to save this proactively without
 *     the user explicitly stating it — a reasonable guess, not a fact the
 *     user vouched for.
 *   - EXTERNAL_CONTENT: derived from untrusted external content (an email
 *     body, a web page, an RSS headline, a Telegram message) ingested into
 *     the model's context — the least trustworthy source, since it's text
 *     JARVIS was asked to read, not text the user said to JARVIS directly.
 *   - TEMPORARY: a short-lived, session-scoped note, not meant to carry
 *     the weight of a durable fact at all.
 *   - BACKGROUND_INFERRED: extracted automatically by the Continuous
 *     Memory background pass (see `src/memory/MemoryExtractor.ts`) after a
 *     conversation turn, with no explicit SAVE_MEMORY tool call behind it
 *     at all — the model never decided "this is worth remembering" in the
 *     moment, a separate, cheap, best-effort pass guessed it from the raw
 *     exchange afterward. Ranked below MODEL_INFERRED (a live SAVE_MEMORY
 *     call Claude actively chose to make, mid-conversation, with full
 *     context) precisely because it's a step further removed from the
 *     user's own words and from the model's in-context judgment — the
 *     Memory Poisoning Defense below means a background-inferred guess can
 *     never silently overwrite ANY of the other four more-trusted sources
 *     for the same key, only ever a prior BACKGROUND_INFERRED value (or an
 *     empty key).
 *
 * See MemoryStore's Memory Poisoning Defense: a write whose trust rank is
 * lower than an existing memory's for the same key is never allowed to
 * silently overwrite it.
 */
export type MemoryTrust =
  | "USER_STATED"
  | "SYSTEM_DERIVED"
  | "MODEL_INFERRED"
  | "BACKGROUND_INFERRED"
  | "EXTERNAL_CONTENT"
  | "TEMPORARY";

export interface MemoryRecord {
  id: string;
  key: string;
  value: string;
  createdAt: string;
  /** Defaults to "fact" for both new saves that don't specify one and pre-existing untyped rows. */
  category: MemoryCategory;
  /** Defaults to 3 ("normal") when not given explicitly. */
  importance: MemoryImportance;
  /** ISO timestamp this memory stops being "active" at, or null if it never expires. */
  expiresAt: string | null;
  /** Provenance of this memory's value. Defaults to "USER_STATED" for both new saves that don't specify one and pre-existing rows saved before this field existed. */
  source: MemoryTrust;
  /**
   * How sure the writer was that this value is correct, 0 (a weak guess)
   * to 1 (certain), or null when no confidence was ever recorded (every
   * row written before this field existed, and every explicit
   * SAVE_MEMORY/DELETE_MEMORY-adjacent save that doesn't pass one — an
   * explicit, user-facing save has no need to self-rate its own
   * confidence). Only `MemoryExtractor`'s background pass currently sets
   * this; nothing else requires it or reads it as a hard gate, it's
   * informational metadata for a future quality/scoring layer
   * (JARVIS_ROADMAP_AUDIT.md #14) to build on.
   */
  confidence: number | null;
}

export interface SaveMemoryInput {
  key: string;
  value: string;
  category?: MemoryCategory;
  importance?: MemoryImportance;
  /**
   * Explicit expiry. When omitted and category is "temporary", MemoryStore
   * fills in a sensible default expiry itself rather than leaving a
   * "temporary" memory that in practice never expires.
   */
  expiresAt?: string | null;
  /** Provenance of this value — see MemoryTrust. Defaults to "USER_STATED" when omitted, matching SAVE_MEMORY's default (an explicit user-facing tool call). */
  source?: MemoryTrust;
  /** See `MemoryRecord.confidence`'s doc comment. Omitted means "not recorded" (stored as null), not "zero confidence". */
  confidence?: number | null;
  /**
   * Optional embedding vector for `value` (and/or `key`), computed by the
   * caller (SaveMemoryTool, when OLLAMA_EMBEDDING_MODEL is configured) —
   * MemoryStore itself never computes embeddings or talks to Ollama, it
   * only stores what it's given. Omitted (the default, and the only
   * possibility when embeddings aren't configured at all) means this
   * memory is exact-match-searchable only, exactly as before this feature
   * existed. Explicit `null` clears a previously-stored embedding.
   */
  embedding?: number[] | null;
}

/** Returned by MemoryStore.save(). */
export interface SaveMemoryResult extends MemoryRecord {
  /**
   * True when this save was REJECTED due to the Memory Poisoning Defense —
   * a lower-trust write conflicted with a higher-trust existing memory for
   * the same key. When true, the returned record is the pre-existing,
   * UNCHANGED record (the attempted write never took effect); the attempt
   * itself is logged to `memory_history` as a flagged conflict, retrievable
   * via `getConflicts()`.
   */
  conflict?: boolean;
}

/** One entry in a memory's change history — recorded whenever SAVE_MEMORY overwrites an existing value for the same key, or a lower-trust write is flagged and rejected. */
export interface MemoryHistoryEntry {
  memoryKey: string;
  oldValue: string;
  newValue: string;
  changedAt: string;
  /** Trust of the value being replaced / the value that was attempted, respectively. Null for history rows written before trust tracking existed. */
  oldTrust: MemoryTrust | null;
  newTrust: MemoryTrust | null;
  /** True when this entry represents a rejected (not applied) lower-trust write — see SaveMemoryResult.conflict. */
  flaggedConflict: boolean;
}
