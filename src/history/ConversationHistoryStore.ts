import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ConversationHistoryEntry } from "@/types/conversationHistory";
import { escapeLikeFragment } from "@/core/db/likeEscape";

const MAX_ROWS = 5000;

/**
 * Durable transcript of what was actually said (user/assistant text turns
 * only — tool calls/results are noise for search, and stay in the
 * short-lived ConversationManager instead) across every conversation
 * JARVIS has ever had, surviving restarts. This is what makes "what did
 * we talk about last week" answerable at all — without it, every
 * conversation vanishes the moment its ConversationManager is garbage
 * collected.
 */
export class ConversationHistoryStore {
  private db: Database;

  constructor(dbPath: string = ":memory:") {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    if (dbPath !== ":memory:") this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS conversation_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_conversation_history_content ON conversation_history(content)`);
  }

  record(role: "user" | "assistant", content: string): void {
    if (content.trim() === "") return; // an assistant turn that only made tool calls has no text worth indexing

    this.db
      .query(`INSERT INTO conversation_history (role, content, timestamp) VALUES (?, ?, ?)`)
      .run(role, content, new Date().toISOString());

    // Bounded like ActivityLog: a durable transcript for search/recall,
    // not an unbounded audit log — old rows are pruned past MAX_ROWS.
    this.db.run(
      `DELETE FROM conversation_history WHERE id NOT IN (SELECT id FROM conversation_history ORDER BY id DESC LIMIT ${MAX_ROWS})`
    );
  }

  /** Case-insensitive substring search over past conversation content, most recent first. */
  search(query: string, limit: number = 10): ConversationHistoryEntry[] {
    // escapeLikeFragment — see its doc comment: a literal `_` or `%` in
    // the query would otherwise act as a LIKE wildcard instead of a
    // literal character, silently matching unrelated transcript rows.
    return this.db
      .query(
        `SELECT id, role, content, timestamp FROM conversation_history WHERE content LIKE ? ESCAPE '\\' COLLATE NOCASE ORDER BY id DESC LIMIT ?`
      )
      .all(`%${escapeLikeFragment(query)}%`, limit) as ConversationHistoryEntry[];
  }

  /** Total number of retained turns (bounded by MAX_ROWS), for a dashboard summary. */
  count(): number {
    const row = this.db.query(`SELECT COUNT(*) as count FROM conversation_history`).get() as { count: number };
    return row.count;
  }

  /** Permanently erases every stored transcript turn. Returns how many rows were removed. */
  clear(): number {
    const before = this.count();
    this.db.run(`DELETE FROM conversation_history`);
    return before;
  }

  close(): void {
    this.db.close();
  }
}
