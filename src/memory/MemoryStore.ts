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

  save(input: SaveMemoryInput): MemoryRecord {
    const record: MemoryRecord = {
      id: randomUUID(),
      key: input.key,
      value: input.value,
      createdAt: new Date().toISOString(),
    };

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

  close(): void {
    this.db.close();
  }
}
