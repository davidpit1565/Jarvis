/**
 * Correction Learning (JARVIS_ROADMAP_AUDIT.md / PR #157's "biggest gap"
 * finding): a behavioral correction is fundamentally different from a fact
 * correction. A fact correction ("actually my timezone is X, not Y") is
 * about WHAT IS TRUE and is already handled by `MemoryExtractor`'s
 * fact-extraction pipeline + `MemoryStore`'s upsert-by-key/trust-rank
 * machinery. A behavioral correction ("no, don't do it that way" / "next
 * time ask before X") is about HOW JARVIS ACTED — it has no natural "key"
 * the way a fact does (there's no stable identity for "the way JARVIS
 * creates reminders" the way there is for "user.timezone"), and its value
 * only matters when JARVIS is about to act in a similar area again, not in
 * every future prompt the way a fact might. That's why this is a distinct,
 * narrow store (see BehaviorCorrectionStore's own doc comment for the full
 * reasoning on why NOT a new MemoryCategory) rather than another row shape
 * bolted onto MemoryStore.
 */

/**
 * What a correction is scoped to — deliberately just the tool-registry id
 * of the action it was about (e.g. "CREATE_REMINDER"), not a free-text
 * topic the model invents. Set by the CALLER (Orchestrator, via
 * `findLastToolCall`) from a real, already-known fact — which tool
 * actually ran — never guessed or echoed back by the extraction model
 * itself. This is what makes retrieval exact and spoof-proof: a correction
 * can only ever be filed under a tool id that genuinely just executed.
 */
export type CorrectionContextKey = string;

export interface BehaviorCorrectionRecord {
  id: string;
  /** The tool/action area this correction applies to — see CorrectionContextKey's doc comment. */
  contextKey: CorrectionContextKey;
  /** The behavioral instruction itself, e.g. "when creating reminders for 'tomorrow morning', ask for a specific time instead of assuming 8am." */
  correction: string;
  /** The tool call this correction was reacting to, for human audit/debugging — never re-parsed or trusted as structured data. */
  originalAction: string;
  /** The user's own correction message, verbatim — the real evidence behind this row, same spirit as MemoryHistoryEntry keeping the old/new text. */
  triggeringMessage: string;
  createdAt: string;
  /**
   * Always "BACKGROUND_INFERRED" today — a correction is only ever
   * detected by the same best-effort background pass as background fact
   * extraction (see MemoryExtractor), never an explicit user-facing save.
   * Kept as a field (not hardcoded) so a future explicit "REMEMBER: don't
   * do X like that again" tool could write a higher-trust row without a
   * schema change.
   */
  source: "BACKGROUND_INFERRED";
  /** 0 (weak guess) .. 1 (near-certain), self-reported by the extraction call — same meaning as MemoryRecord.confidence. */
  confidence: number | null;
  /**
   * Guardrail (see CLAUDE.md task spec point 4): true when the extraction
   * call flagged that this correction conflicts with an explicit standing
   * preference already recorded in MemoryStore. A single correction is
   * never allowed to silently override a standing preference — a flagged
   * row is still stored (so it isn't lost) but is always surfaced with an
   * explicit caveat rather than presented as settled guidance. See
   * `correctionNote.ts`.
   */
  flaggedPreferenceConflict: boolean;
  /** The standing preference text it appears to conflict with, when `flaggedPreferenceConflict` is true — for human/model review, not re-parsed. */
  conflictingPreference: string | null;
}

export interface CreateBehaviorCorrectionInput {
  contextKey: CorrectionContextKey;
  correction: string;
  originalAction: string;
  triggeringMessage: string;
  confidence?: number | null;
  flaggedPreferenceConflict?: boolean;
  conflictingPreference?: string | null;
}
