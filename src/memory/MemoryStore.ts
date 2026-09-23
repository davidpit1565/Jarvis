import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { escapeLikeFragment } from "@/core/db/likeEscape";
import type {
  MemoryCategory,
  MemoryHistoryEntry,
  MemoryImportance,
  MemoryRecord,
  MemoryTrust,
  SaveMemoryInput,
  SaveMemoryResult,
} from "@/types/memory";
import { cosineSimilarity } from "@/core/embeddings/similarity";

const DEFAULT_CATEGORY: MemoryCategory = "fact";
const DEFAULT_IMPORTANCE: MemoryImportance = 3;
const DEFAULT_TRUST: MemoryTrust = "USER_STATED";
/** A "temporary" memory saved with no explicit expiry gets one day — long enough to survive the rest of a session, short enough that it doesn't quietly become permanent. */
const DEFAULT_TEMPORARY_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * Performance (Phase 48): `search()`/`getActive()` had no LIMIT at all —
 * `SEARCH_MEMORY` with an empty query ("list everything remembered so
 * far", per its own doc comment) or a broad fragment matched every row in
 * `memory_records` and returned the whole table, unbounded, straight into
 * the model's context. A bounded, most-recent-first slice is what any
 * caller (a tool call feeding the brain, or a dashboard) actually needs;
 * see each method's own doc comment.
 */
const DEFAULT_QUERY_LIMIT = 200;

/**
 * Semantic Memory Search (additive, opt-in — see `searchSemantic`'s own doc
 * comment). Only ever consulted for memories that actually have a stored
 * embedding, which only happens when `OLLAMA_EMBEDDING_MODEL` is
 * configured — this constant has zero effect otherwise.
 *
 * Chosen deliberately low (0.5 on cosine similarity's [-1, 1] scale, i.e.
 * "somewhat related" rather than "nearly identical"), because the whole
 * point of this feature is *recall* for a small, personal dataset a human
 * skims — e.g. matching "dentist" against a memory saved as "appointment
 * with Dr. Cohen," which share no words at all. `nomic-embed-text` (the
 * model this is written against) isn't as tightly contrastively-tuned as
 * some retrieval-specific embedding models, so genuinely related short
 * phrases often land in the 0.4-0.7 range rather than requiring something
 * close to 1.0. Set too high (e.g. 0.8+), this would miss exactly the
 * paraphrase cases semantic search exists to catch; set too low (e.g.
 * 0.2), it would start surfacing memories that are merely in the same
 * broad topic. This is memory *search* (results are shown to/read by the
 * user or Claude, never blindly trusted as a match), so erring toward
 * recall over precision is the right tradeoff — unlike semantic *caching*
 * (see ToolResultCache's own, much higher threshold), a bad semantic
 * search result costs nothing more than one extra, slightly-irrelevant row
 * in a list.
 */
const SEMANTIC_MEMORY_SIMILARITY_THRESHOLD = 0.5;

/**
 * Memory Poisoning Defense: how much a source is trusted, highest first.
 * A write only ever overwrites an existing value for the same key when its
 * trust rank is >= the existing record's — a lower-rank write conflicting
 * with a higher-rank existing value is rejected and flagged instead of
 * silently applied. Equal rank (the common case: two USER_STATED corrections
 * in a row) always overwrites, exactly as MemoryStore has always behaved.
 */
const TRUST_RANK: Record<MemoryTrust, number> = {
  USER_STATED: 4,
  SYSTEM_DERIVED: 3,
  MODEL_INFERRED: 2,
  EXTERNAL_CONTENT: 1,
  TEMPORARY: 0,
};

const SELECT_COLUMNS = `
  id,
  key,
  value,
  created_at as createdAt,
  COALESCE(category, 'fact') as category,
  COALESCE(importance, 3) as importance,
  expires_at as expiresAt,
  COALESCE(source, 'USER_STATED') as source
`;

type MemoryRow = Omit<MemoryRecord, "importance"> & { importance: number };

function rowToRecord(row: MemoryRow): MemoryRecord {
  return { ...row, importance: row.importance as MemoryImportance };
}

/** JSON-encodes an embedding for storage in the `embedding` TEXT column, or null for "no embedding"/"clear it". */
function serializeEmbedding(embedding: number[] | null | undefined): string | null {
  if (embedding == null) return null;
  return JSON.stringify(embedding);
}

/**
 * Minimal local memory layer backed by SQLite. Phase 1 only stores explicit
 * key/value records saved on purpose — no automatic conversation capture,
 * no embeddings, no vector search.
 *
 * Phase 2 (Memory Quality Layer / Expiration / Conflict Resolver) adds:
 *   - `category`/`importance` on each record, both defaulted so old,
 *     untyped rows and callers that never pass them keep working exactly
 *     as before.
 *   - `expiresAt`, nullable like ReminderStore's `dueAt` — null means "never
 *     expires". A "temporary" memory gets a default expiry unless the
 *     caller explicitly gives one.
 *   - a `memory_history` table logging old -> new value whenever a save
 *     overwrites an existing key with a meaningfully different value. The
 *     new value still wins immediately (unchanged upsert behavior) — this
 *     only keeps a paper trail so a fact silently changing isn't a fact
 *     silently *lost*.
 */
export class MemoryStore {
  private db: Database;

  constructor(dbPath: string = ":memory:") {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    // WAL lets a read (e.g. SEARCH_MEMORY) and a write (SAVE_MEMORY) happen
    // concurrently without blocking each other, and survives a hard kill
    // more safely than the default rollback journal. No effect on ":memory:".
    if (dbPath !== ":memory:") this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS memory_records (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memory_records_key ON memory_records(key)`);

    // A database created before category/importance/expires_at existed
    // won't have those columns — SQLite has no "ADD COLUMN IF NOT EXISTS,"
    // so this just ignores the error when the column is already there.
    // Same best-effort migration pattern as ReminderStore.
    for (const ddl of [
      `ALTER TABLE memory_records ADD COLUMN category TEXT`,
      `ALTER TABLE memory_records ADD COLUMN importance INTEGER`,
      `ALTER TABLE memory_records ADD COLUMN expires_at TEXT`,
      // Memory Trust System: additive, never destructive — same
      // best-effort "ignore if already there" migration pattern as the
      // three columns above and as ReminderStore uses elsewhere. A
      // pre-existing row with no `source` reads back as 'USER_STATED' via
      // SELECT_COLUMNS's COALESCE, same treatment as untyped
      // category/importance rows already get.
      `ALTER TABLE memory_records ADD COLUMN source TEXT`,
      // Semantic Memory Search: additive, nullable, opt-in. NULL (every row
      // written before this pass, and every row written while
      // OLLAMA_EMBEDDING_MODEL is unset) simply means "no embedding stored
      // for this memory" — searchSemantic() skips such rows entirely, and
      // every other method (search/getActive/get/etc.) never looks at this
      // column at all. Stored as a JSON-encoded number[] text blob rather
      // than a dedicated vector type — SQLite has none, and at this scale
      // (dozens to low-thousands of rows) that's not a real limitation.
      // Same best-effort "ignore if already there" migration pattern as
      // every column above.
      `ALTER TABLE memory_records ADD COLUMN embedding TEXT`,
    ]) {
      try {
        this.db.run(ddl);
      } catch {
        // already exists
      }
    }

    this.db.run(`
      CREATE TABLE IF NOT EXISTS memory_history (
        id TEXT PRIMARY KEY,
        memory_key TEXT NOT NULL,
        old_value TEXT NOT NULL,
        new_value TEXT NOT NULL,
        changed_at TEXT NOT NULL
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memory_history_key ON memory_history(memory_key)`);

    // Memory Poisoning Defense: extends memory_history (rather than a
    // parallel table) with the trust of each side of a change, and whether
    // the write was actually applied or rejected/flagged. Same additive
    // best-effort migration pattern as above.
    for (const ddl of [
      `ALTER TABLE memory_history ADD COLUMN old_trust TEXT`,
      `ALTER TABLE memory_history ADD COLUMN new_trust TEXT`,
      `ALTER TABLE memory_history ADD COLUMN flagged_conflict INTEGER`,
    ]) {
      try {
        this.db.run(ddl);
      } catch {
        // already exists
      }
    }
  }

  /**
   * Upserts by key: saving the same key again replaces the previous fact
   * rather than adding a second row. Without this, correcting a fact
   * ("actually my timezone is X, not Y") would leave both the old and new
   * value in the store — SEARCH_MEMORY would then hand Claude two
   * conflicting facts for the same key with no way to tell which is
   * current, exactly backwards from what a "memory" is supposed to do.
   *
   * When an existing value for the key is being replaced with a
   * meaningfully different one, this is a "conflict": the new value still
   * wins (same behavior as always), but the old -> new change is logged to
   * `memory_history` first so it isn't lost without a trace.
   */
  /**
   * Upserts by key — see the class doc comment for why. As of the Memory
   * Trust System, this also enforces the Memory Poisoning Defense: when an
   * existing value would be replaced with a *meaningfully different* one
   * whose trust rank is LOWER than the existing record's (e.g. a
   * MODEL_INFERRED or EXTERNAL_CONTENT write trying to overwrite an
   * existing USER_STATED fact), the write is rejected — the existing
   * record is returned unchanged, and the attempt is logged to
   * `memory_history` with `flaggedConflict: true` rather than silently
   * lost. Equal-or-higher trust always overwrites, exactly as before —
   * this only ever blocks a *downgrade*.
   */
  save(input: SaveMemoryInput): SaveMemoryResult {
    // COLLATE NOCASE: a key is a stable identifier the model composes
    // itself each call (e.g. "user.timezone"), with no guarantee it uses
    // the same casing twice — without this, a differently-cased re-save
    // of the same logical key would miss `existing` entirely and INSERT a
    // second row instead of upserting, defeating the "one fact per key"
    // guarantee this method exists for (see class doc comment above) and
    // letting a MODEL_INFERRED/EXTERNAL_CONTENT write dodge the Memory
    // Poisoning Defense's trust-rank check below by using a case variant
    // of an existing USER_STATED key. search()'s LIKE already matches
    // case-insensitively, so this makes exact-key lookups agree with it.
    const existing = this.db
      .query(`SELECT id, value, COALESCE(source, 'USER_STATED') as source FROM memory_records WHERE key = ? COLLATE NOCASE`)
      .get(input.key) as { id: string; value: string; source: MemoryTrust } | null;
    const createdAt = new Date().toISOString();
    const category = input.category ?? DEFAULT_CATEGORY;
    const importance = input.importance ?? DEFAULT_IMPORTANCE;
    const source = input.source ?? DEFAULT_TRUST;
    const expiresAt = this.resolveExpiresAt(category, input.expiresAt, createdAt);

    if (existing) {
      const valueChanged = existing.value.trim() !== input.value.trim();

      if (TRUST_RANK[source] < TRUST_RANK[existing.source]) {
        // Poisoning defense: a lower-trust source can never take over this
        // key, even via a same-value resave — the unconditional UPDATE
        // below writes `source` regardless of whether the text changed, so
        // gating this only on `valueChanged` would let a same-value
        // MODEL_INFERRED resave silently downgrade an existing
        // USER_STATED record's trust rank, defeating the defense on the
        // very next write. Log the attempt, but never apply it.
        this.db
          .query(
            `INSERT INTO memory_history (id, memory_key, old_value, new_value, changed_at, old_trust, new_trust, flagged_conflict) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
          )
          .run(randomUUID(), input.key, existing.value, input.value, createdAt, existing.source, source);

        const unchanged = this.getByKey(input.key);
        // getByKey can't actually miss here — `existing` was just read from
        // the same table inside this call — but satisfy the type checker
        // without asserting away a real (if impossible) null.
        if (!unchanged) throw new Error(`Memory record disappeared mid-write for key: ${input.key}`);
        return { ...unchanged, conflict: true };
      }

      if (valueChanged) {
        this.db
          .query(
            `INSERT INTO memory_history (id, memory_key, old_value, new_value, changed_at, old_trust, new_trust, flagged_conflict) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
          )
          .run(randomUUID(), input.key, existing.value, input.value, createdAt, existing.source, source);
      }
      // input.embedding === undefined (the overwhelming common case, and
      // the *only* case when embeddings aren't configured at all) leaves
      // whatever embedding this key already had untouched — SAVE_MEMORY
      // only ever passes an embedding when it actually computed one, and a
      // caller not opting into that shouldn't silently blow away one this
      // key already has. Explicit null clears it.
      if (input.embedding !== undefined) {
        this.db
          .query(
            `UPDATE memory_records SET value = ?, created_at = ?, category = ?, importance = ?, expires_at = ?, source = ?, embedding = ? WHERE id = ?`
          )
          .run(input.value, createdAt, category, importance, expiresAt, source, serializeEmbedding(input.embedding), existing.id);
      } else {
        this.db
          .query(
            `UPDATE memory_records SET value = ?, created_at = ?, category = ?, importance = ?, expires_at = ?, source = ? WHERE id = ?`
          )
          .run(input.value, createdAt, category, importance, expiresAt, source, existing.id);
      }
      return { id: existing.id, key: input.key, value: input.value, createdAt, category, importance, expiresAt, source };
    }

    const record: MemoryRecord = {
      id: randomUUID(),
      key: input.key,
      value: input.value,
      createdAt,
      category,
      importance,
      expiresAt,
      source,
    };
    this.db
      .query(
        `INSERT INTO memory_records (id, key, value, created_at, category, importance, expires_at, source, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.key,
        record.value,
        record.createdAt,
        record.category,
        record.importance,
        record.expiresAt,
        record.source,
        serializeEmbedding(input.embedding)
      );

    return record;
  }

  /** A "temporary" memory with no explicit expiry gets a default TTL; every other case is exactly what the caller asked for (including null = never). */
  private resolveExpiresAt(
    category: MemoryCategory,
    explicit: string | null | undefined,
    createdAt: string
  ): string | null {
    if (explicit !== undefined) return explicit;
    if (category === "temporary") {
      return new Date(new Date(createdAt).getTime() + DEFAULT_TEMPORARY_TTL_MS).toISOString();
    }
    return null;
  }

  get(id: string): MemoryRecord | null {
    const row = this.db.query(`SELECT ${SELECT_COLUMNS} FROM memory_records WHERE id = ?`).get(id) as MemoryRow | null;
    return row ? rowToRecord(row) : null;
  }

  /** Exact key lookup — the natural handle Claude/the user actually has, unlike the opaque internal id. */
  getByKey(key: string): MemoryRecord | null {
    // COLLATE NOCASE — see save()'s comment on why key lookups must be
    // case-insensitive, matching search()'s own case-insensitive LIKE.
    const row = this.db
      .query(`SELECT ${SELECT_COLUMNS} FROM memory_records WHERE key = ? COLLATE NOCASE`)
      .get(key) as MemoryRow | null;
    return row ? rowToRecord(row) : null;
  }

  /**
   * Matches `fragment` against either the key or the value — without
   * this, "what did I say about my dog" would miss a fact saved under an
   * unrelated key (e.g. "pets.name") whose value happens to mention
   * "dog", since only the key was ever searched.
   *
   * Unchanged from Phase 1: still returns expired memories too. Callers
   * that want expiry-aware results use `getActive()` instead.
   *
   * Bounded to `limit` (most recent first, since `ORDER BY created_at
   * DESC` already ran) — an empty `fragment` (SEARCH_MEMORY's own "list
   * everything" shape) or a broad one otherwise matched and returned every
   * row in the table. See `DEFAULT_QUERY_LIMIT`'s own doc comment.
   */
  search(fragment: string, limit: number = DEFAULT_QUERY_LIMIT): MemoryRecord[] {
    // escapeLikeFragment: a literal `_` or `%` in the search fragment
    // (e.g. "wifi_password") would otherwise be interpreted as a LIKE
    // wildcard instead of a literal character, silently matching
    // unrelated rows like "wifi.password" — see the helper's doc comment.
    const pattern = `%${escapeLikeFragment(fragment)}%`;
    const rows = this.db
      .query(
        `SELECT ${SELECT_COLUMNS} FROM memory_records WHERE key LIKE ? ESCAPE '\\' OR value LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT ?`
      )
      .all(pattern, pattern, limit) as MemoryRow[];
    return rows.map(rowToRecord);
  }

  /**
   * Semantic Memory Search (additive — see `SEMANTIC_MEMORY_SIMILARITY_THRESHOLD`'s
   * own doc comment for the threshold reasoning). Alongside `search()`, not
   * a replacement for it: `search()`'s plain-`LIKE` behavior is completely
   * unchanged and remains the default/fallback. This is only ever useful
   * once at least one memory has a stored embedding (SAVE_MEMORY only
   * computes one when OLLAMA_EMBEDDING_MODEL is configured) — with none,
   * this simply returns an empty array, cheaply.
   *
   * A plain linear scan over every row with a non-null embedding, computing
   * cosine similarity against `queryEmbedding` in JS. Deliberately not
   * indexed/optimized: this is a small, personal memory store (dozens to
   * low-thousands of rows), not a production vector database — a full scan
   * over that many rows is effectively instant, and building real vector
   * indexing infrastructure for a dataset this size would be pure
   * over-engineering.
   *
   * Returns matches at or above the similarity threshold, most-similar
   * first, bounded to `limit`. Unlike `search()`, this does NOT return
   * already-expired memories (there is no equivalent of `search()`'s
   * "search everything including expired" behavior here — this is a new
   * method with no existing callers/behavior to preserve).
   */
  searchSemantic(queryEmbedding: number[], limit: number = DEFAULT_QUERY_LIMIT): Array<MemoryRecord & { similarity: number }> {
    const now = new Date().toISOString();
    const rows = this.db
      .query(
        `SELECT ${SELECT_COLUMNS}, embedding FROM memory_records
         WHERE embedding IS NOT NULL AND (expires_at IS NULL OR expires_at > ?)`
      )
      .all(now) as Array<MemoryRow & { embedding: string }>;

    const scored: Array<MemoryRecord & { similarity: number }> = [];
    for (const row of rows) {
      let embedding: number[];
      try {
        embedding = JSON.parse(row.embedding);
      } catch {
        continue; // corrupt/foreign data in the column — skip rather than crash a search
      }
      if (!Array.isArray(embedding) || embedding.length !== queryEmbedding.length) continue;

      const similarity = cosineSimilarity(queryEmbedding, embedding);
      if (similarity >= SEMANTIC_MEMORY_SIMILARITY_THRESHOLD) {
        const { embedding: _discard, ...record } = row;
        scored.push({ ...rowToRecord(record as MemoryRow), similarity });
      }
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, limit);
  }

  /**
   * All memories that haven't expired yet (expiresAt is null, or is in the
   * future relative to `now`), newest first. This is the expiry-aware
   * counterpart to `search()`/list-everything — mirrors how
   * `ReminderStore.list()` excludes completed reminders by default.
   *
   * Bounded to `limit` (most recent first), same reasoning as `search()`.
   */
  getActive(now: string = new Date().toISOString(), limit: number = DEFAULT_QUERY_LIMIT): MemoryRecord[] {
    const rows = this.db
      .query(
        `SELECT ${SELECT_COLUMNS} FROM memory_records WHERE expires_at IS NULL OR expires_at > ? ORDER BY created_at DESC LIMIT ?`
      )
      .all(now, limit) as MemoryRow[];
    return rows.map(rowToRecord);
  }

  /** Permanently removes every already-expired memory. Returns how many rows were purged. */
  purgeExpired(now: string = new Date().toISOString()): number {
    const result = this.db.query(`DELETE FROM memory_records WHERE expires_at IS NOT NULL AND expires_at <= ?`).run(now);
    return result.changes;
  }

  /** The old -> new change log for a key, oldest first — how a fact's value has evolved over time, including rejected/flagged conflicting writes. */
  getHistory(key: string): MemoryHistoryEntry[] {
    const rows = this.db
      .query(
        `SELECT memory_key as memoryKey, old_value as oldValue, new_value as newValue, changed_at as changedAt,
                old_trust as oldTrust, new_trust as newTrust, COALESCE(flagged_conflict, 0) as flaggedConflict
         FROM memory_history WHERE memory_key = ? ORDER BY changed_at ASC`
      )
      .all(key) as Array<Omit<MemoryHistoryEntry, "flaggedConflict"> & { flaggedConflict: number }>;
    return rows.map((row) => ({ ...row, flaggedConflict: Boolean(row.flaggedConflict) }));
  }

  /**
   * Every rejected (flagged) lower-trust write ever attempted, most recent
   * first — the durable record a human/admin surface can review of "JARVIS
   * refused to let X overwrite a more-trusted memory." Optionally scoped to
   * one key. This is the Memory Poisoning Defense's own audit trail,
   * distinct from ToolAuditLog (which only knows SAVE_MEMORY was called
   * and succeeded, not that its value was actually rejected).
   */
  getConflicts(key?: string): MemoryHistoryEntry[] {
    const whereClause = key ? `WHERE flagged_conflict = 1 AND memory_key = ?` : `WHERE flagged_conflict = 1`;
    const rows = this.db
      .query(
        `SELECT memory_key as memoryKey, old_value as oldValue, new_value as newValue, changed_at as changedAt,
                old_trust as oldTrust, new_trust as newTrust, COALESCE(flagged_conflict, 0) as flaggedConflict
         FROM memory_history ${whereClause} ORDER BY changed_at DESC`
      )
      .all(...(key ? [key] : [])) as Array<Omit<MemoryHistoryEntry, "flaggedConflict"> & { flaggedConflict: number }>;
    return rows.map((row) => ({ ...row, flaggedConflict: Boolean(row.flaggedConflict) }));
  }

  delete(id: string): boolean {
    const result = this.db.query(`DELETE FROM memory_records WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  /** Deletes by exact key — the natural handle Claude/the user actually has, unlike the opaque internal id. */
  deleteByKey(key: string): boolean {
    // COLLATE NOCASE — see save()'s comment; a delete-by-key call using
    // different casing than the record was saved under must still find it.
    const result = this.db.query(`DELETE FROM memory_records WHERE key = ? COLLATE NOCASE`).run(key);
    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
