import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { BehaviorCorrectionRecord, CreateBehaviorCorrectionInput } from "@/types/behaviorCorrections";

/**
 * Correction Learning: a narrow, separate store for behavioral corrections
 * — distinct from `MemoryStore`'s general fact table. See
 * `types/behaviorCorrections.ts`'s own doc comment for the conceptual
 * distinction; this comment covers the storage-design decision itself
 * (CLAUDE.md task spec point 2), which was actually weighed, not just
 * defaulted to:
 *
 * Option (a) — a new, narrow table/store keyed by context (chosen here).
 * Option (b) — a new `MemoryCategory` value inside the existing MemoryStore.
 *
 * (b) was rejected for three concrete reasons:
 *   1. MemoryStore's entire upsert model is "one row per KEY" — a single
 *      stable string the model composes once (e.g. "user.timezone") that a
 *      later correction overwrites in place. A behavioral correction has no
 *      such natural single key: "when creating reminders" isn't one fact
 *      that gets superseded, it's a growing (but capped) set of situational
 *      notes about one action area, several of which can be simultaneously
 *      true and worth keeping (e.g. "ask for a specific time" AND "default
 *      to the user's home timezone"). Forcing that into one key-per-fact
 *      row would mean either silently dropping all-but-the-latest
 *      correction for an area (losing real signal) or inventing sub-keys
 *      per correction, which is just reimplementing a second table's worth
 *      of structure inside MemoryStore's schema.
 *   2. Retrieval shape is different. Every MemoryStore category is either
 *      searched on demand (SEARCH_MEMORY) or dumped wholesale into
 *      `getActive()`. A correction's whole value is being retrieved when
 *      and only when JARVIS is about to act in the same area again —
 *      that's a lookup by context key (tool id), not a text search or an
 *      unconditional dump. A separate table with its own
 *      `listForContextKeys` is a far more direct fit than bolting a
 *      secondary index onto MemoryStore for one category.
 *   3. The Memory Poisoning Defense's trust-rank machinery exists to decide
 *      "does this NEW value get to overwrite THIS EXISTING value for the
 *      same key" — a question that doesn't apply here, since corrections
 *      don't overwrite each other by key at all (see #1). What a correction
 *      DOES need — and gets here, see `add()` below — is its own, simpler
 *      per-context cap so a never-ending stream of situational notes about
 *      one tool can't grow forever (the same discipline the Goal Engine
 *      audit already enforced for goals via MAX_GOALS_IN_NOTE), which is a
 *      different mechanism than trust-ranked overwrite and doesn't need
 *      MemoryStore's machinery to get it right.
 *
 * What IS reused conceptually from MemoryStore: `confidence` (self-reported
 * by the same extraction call, same honest-uncertainty meaning) and a
 * `source` field shaped the same way as `MemoryTrust`, for the same
 * forward-compatibility reason — see BehaviorCorrectionRecord's doc
 * comment. Today only "BACKGROUND_INFERRED" is ever written, so there is no
 * actual trust-rank conflict to adjudicate yet; if a second, higher-trust
 * write path is added later (e.g. an explicit "remember not to do that"
 * tool), this is the natural point to add a real trust-rank check the same
 * shape as MemoryStore's.
 */

/**
 * Hard ceiling on how many corrections one context key (tool id) can hold
 * at once — same reasoning as `goalProgressNote.ts`'s MAX_GOALS_IN_NOTE:
 * without a cap, a tool JARVIS gets corrected about repeatedly over months
 * would accumulate an ever-growing list, every one of which is a candidate
 * for being surfaced into a future prompt. `add()` enforces this by
 * deleting the oldest rows for that context key beyond the cap — newest
 * corrections are the most likely to reflect current, still-wanted
 * behavior, so they're what's kept.
 */
const MAX_CORRECTIONS_PER_CONTEXT = 8;

/** Hard ceiling on how many corrections any one retrieval ever returns, regardless of how many context keys are queried — see `listRelevant`'s doc comment. */
const MAX_RETRIEVAL_RESULTS = 5;

type CorrectionRow = Omit<BehaviorCorrectionRecord, "flaggedPreferenceConflict"> & { flaggedPreferenceConflict: number };

function rowToRecord(row: CorrectionRow): BehaviorCorrectionRecord {
  return { ...row, flaggedPreferenceConflict: Boolean(row.flaggedPreferenceConflict) };
}

const SELECT_COLUMNS = `
  id,
  context_key as contextKey,
  correction,
  original_action as originalAction,
  triggering_message as triggeringMessage,
  created_at as createdAt,
  source,
  confidence,
  flagged_preference_conflict as flaggedPreferenceConflict,
  conflicting_preference as conflictingPreference
`;

export class BehaviorCorrectionStore {
  private db: Database;

  constructor(dbPath: string = ":memory:") {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    if (dbPath !== ":memory:") this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS behavior_corrections (
        id TEXT PRIMARY KEY,
        context_key TEXT NOT NULL,
        correction TEXT NOT NULL,
        original_action TEXT NOT NULL,
        triggering_message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'BACKGROUND_INFERRED',
        confidence REAL,
        flagged_preference_conflict INTEGER NOT NULL DEFAULT 0,
        conflicting_preference TEXT
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_behavior_corrections_context_key ON behavior_corrections(context_key)`);
  }

  /**
   * Records a new correction, then enforces `MAX_CORRECTIONS_PER_CONTEXT`
   * for that context key by deleting the oldest rows beyond the cap — see
   * the class doc comment for why a per-context cap, not a trust-ranked
   * overwrite, is the right growth control here.
   */
  add(input: CreateBehaviorCorrectionInput): BehaviorCorrectionRecord {
    const record: BehaviorCorrectionRecord = {
      id: randomUUID(),
      contextKey: input.contextKey,
      correction: input.correction,
      originalAction: input.originalAction,
      triggeringMessage: input.triggeringMessage,
      createdAt: new Date().toISOString(),
      source: "BACKGROUND_INFERRED",
      confidence: input.confidence ?? null,
      flaggedPreferenceConflict: input.flaggedPreferenceConflict ?? false,
      conflictingPreference: input.conflictingPreference ?? null,
    };

    this.db
      .query(
        `INSERT INTO behavior_corrections
           (id, context_key, correction, original_action, triggering_message, created_at, source, confidence, flagged_preference_conflict, conflicting_preference)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.contextKey,
        record.correction,
        record.originalAction,
        record.triggeringMessage,
        record.createdAt,
        record.source,
        record.confidence,
        record.flaggedPreferenceConflict ? 1 : 0,
        record.conflictingPreference
      );

    this.enforceCap(input.contextKey);
    return record;
  }

  /** Deletes the oldest rows for `contextKey` beyond MAX_CORRECTIONS_PER_CONTEXT, keeping the newest. */
  private enforceCap(contextKey: string): void {
    this.db
      .query(
        `DELETE FROM behavior_corrections
         WHERE context_key = ?
           AND id NOT IN (
             SELECT id FROM behavior_corrections
             WHERE context_key = ?
             ORDER BY created_at DESC, rowid DESC
             LIMIT ?
           )`
      )
      .run(contextKey, contextKey, MAX_CORRECTIONS_PER_CONTEXT);
  }

  /** All corrections ever filed for one context key (tool id), newest first, uncapped beyond what `add()` already keeps. */
  listForContext(contextKey: string): BehaviorCorrectionRecord[] {
    const rows = this.db
      .query(`SELECT ${SELECT_COLUMNS} FROM behavior_corrections WHERE context_key = ? ORDER BY created_at DESC, rowid DESC`)
      .all(contextKey) as CorrectionRow[];
    return rows.map(rowToRecord);
  }

  /**
   * Relevance-gated retrieval (CLAUDE.md task spec point 3): returns the
   * most recent corrections across any of `contextKeys`, newest first,
   * bounded to `MAX_RETRIEVAL_RESULTS` regardless of how many keys/rows
   * actually match — the same discipline `goalProgressNote.ts` applies via
   * MAX_GOALS_IN_NOTE, so this can never dump an unbounded list into a
   * prompt even if many context keys are passed at once. An empty
   * `contextKeys` array returns nothing — callers (see `correctionNote.ts`)
   * only pass keys they've determined are actually relevant to the current
   * message; this method never guesses relevance on its own.
   */
  listRelevant(contextKeys: string[], limit: number = MAX_RETRIEVAL_RESULTS): BehaviorCorrectionRecord[] {
    if (contextKeys.length === 0) return [];
    const placeholders = contextKeys.map(() => "?").join(", ");
    const rows = this.db
      .query(
        `SELECT ${SELECT_COLUMNS} FROM behavior_corrections
         WHERE context_key IN (${placeholders})
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`
      )
      .all(...contextKeys, Math.min(limit, MAX_RETRIEVAL_RESULTS)) as CorrectionRow[];
    return rows.map(rowToRecord);
  }

  get(id: string): BehaviorCorrectionRecord | null {
    const row = this.db.query(`SELECT ${SELECT_COLUMNS} FROM behavior_corrections WHERE id = ?`).get(id) as CorrectionRow | null;
    return row ? rowToRecord(row) : null;
  }

  delete(id: string): boolean {
    const result = this.db.query(`DELETE FROM behavior_corrections WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
