export type MemoryCategory = "fact" | "preference" | "commitment" | "temporary";

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
 *
 * See MemoryStore's Memory Poisoning Defense: a write whose trust rank is
 * lower than an existing memory's for the same key is never allowed to
 * silently overwrite it.
 */
export type MemoryTrust = "USER_STATED" | "SYSTEM_DERIVED" | "MODEL_INFERRED" | "EXTERNAL_CONTENT" | "TEMPORARY";

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
