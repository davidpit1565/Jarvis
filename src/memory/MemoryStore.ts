import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { MemoryRecord, SaveMemoryInput } from "@/types/memory";

/**
 * Minimal local memory layer backed by SQLite. Phase 1 only stores explicit
 * key/value records saved on purpose — no automatic conversation capture,
 * no embeddings, no vector search.
 */
export class MemoryStore {
  private db: Database;

  constructor(dbPath: string = ":memory:") {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS memory_records (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memory_records_key ON memory_records(key)`);
  }

  /**
   * Upserts by key: saving the same key again replaces the previous fact
   * rather than adding a second row. Without this, correcting a fact
   * ("actually my timezone is X, not Y") would leave both the old and new
   * value in the store — SEARCH_MEMORY would then hand Claude two
   * conflicting facts for the same key with no way to tell which is
   * current, exactly backwards from what a "memory" is supposed to do.
   */
  save(input: SaveMemoryInput): MemoryRecord {
    const existing = this.db.query(`SELECT id FROM memory_records WHERE key = ?`).get(input.key) as {
      id: string;
    } | null;
    const createdAt = new Date().toISOString();

    if (existing) {
      this.db
        .query(`UPDATE memory_records SET value = ?, created_at = ? WHERE id = ?`)
        .run(input.value, createdAt, existing.id);
      return { id: existing.id, key: input.key, value: input.value, createdAt };
    }

    const record: MemoryRecord = { id: randomUUID(), key: input.key, value: input.value, createdAt };
    this.db
      .query(`INSERT INTO memory_records (id, key, value, created_at) VALUES (?, ?, ?, ?)`)
      .run(record.id, record.key, record.value, record.createdAt);

    return record;
  }

  get(id: string): MemoryRecord | null {
    const row = this.db
      .query(`SELECT id, key, value, created_at as createdAt FROM memory_records WHERE id = ?`)
      .get(id) as MemoryRecord | null;
    return row ?? null;
  }

  search(keyFragment: string): MemoryRecord[] {
    const rows = this.db
      .query(
        `SELECT id, key, value, created_at as createdAt FROM memory_records WHERE key LIKE ? ORDER BY created_at DESC`
      )
      .all(`%${keyFragment}%`) as MemoryRecord[];
    return rows;
  }

  delete(id: string): boolean {
    const result = this.db.query(`DELETE FROM memory_records WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  /** Deletes by exact key — the natural handle Claude/the user actually has, unlike the opaque internal id. */
  deleteByKey(key: string): boolean {
    const result = this.db.query(`DELETE FROM memory_records WHERE key = ?`).run(key);
    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
