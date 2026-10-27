import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

interface Row {
  source_id: string;
  cursor_json: string | null;
  new_items_json: string;
  polled_at: string | null;
}

export interface WatcherRecord<TItem = unknown> {
  sourceId: string;
  newItems: TItem[];
  polledAt: string;
}

/**
 * Generic "where did we leave off, and what did the latest poll find that
 * was new" cache for any pollable `WatchSource` (a GitHub repo, a news
 * topic, eventually a Gmail label, etc.) — one row per source id.
 *
 * This is the shared storage engine `CLAUDE.md`'s "Approved for build:
 * generalized Proactive Watcher" spec asks for: `GitHubActivityStore`
 * (see its own doc comment) is refactored to persist through this class
 * instead of its own bespoke `github_activity_state` table, and
 * `src/news/newsWatchSources.ts` uses it directly — one engine, not one
 * hand-rolled SQL table per source type.
 *
 * Cursor and item shapes are source-defined and opaque to this store: it
 * only ever persists/returns whatever JSON-serializable value a
 * `WatchSource`'s own `poll()` hands it. That's the same "generic over
 * cursor/item type" property `WatchSource<TCursor, TItem>` itself has —
 * this class is the storage half of that abstraction, `pollWatchSources`
 * (src/watcher/pollWatchSources.ts) is the polling half.
 *
 * Deliberately stores only the *latest* poll's new-items batch per source,
 * not a growing history — same reasoning `GitHubActivityStore`'s own doc
 * comment already gave for its predecessor table (an ever-growing table
 * here would be the same unbounded-growth failure mode
 * `CommitmentStore`/`GoalStore` already guard against for their own
 * stores). A poll that finds nothing new overwrites the previous
 * (possibly non-empty) batch with an empty one — correct, since a note
 * composed from this store should stop mentioning something once a poll
 * has confirmed nothing's changed since.
 *
 * Same SQLite house style as every other store in this codebase
 * (bun:sqlite, WAL mode, mkdirSync for the parent directory).
 */
export class WatcherStore {
  private db: Database;

  constructor(dbPath: string = ":memory:") {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    if (dbPath !== ":memory:") this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS watcher_state (
        source_id TEXT PRIMARY KEY,
        cursor_json TEXT,
        new_items_json TEXT NOT NULL DEFAULT '[]',
        polled_at TEXT
      )
    `);
  }

  /** The cursor for one source id, or undefined if it's never been polled (or never recorded a poll result) before. */
  getCursor<TCursor = unknown>(sourceId: string): TCursor | undefined {
    const row = this.db.query(`SELECT cursor_json FROM watcher_state WHERE source_id = ?`).get(sourceId) as
      | { cursor_json: string | null }
      | null;
    if (!row || row.cursor_json === null) return undefined;
    const parsed = JSON.parse(row.cursor_json);
    return parsed === null ? undefined : (parsed as TCursor);
  }

  /** Upserts a source's cursor and the items this poll found to be new, replacing whatever the previous poll had recorded. */
  recordPoll<TCursor = unknown, TItem = unknown>(sourceId: string, cursor: TCursor, newItems: TItem[], polledAt: string = new Date().toISOString()): void {
    this.db
      .query(
        `INSERT INTO watcher_state (source_id, cursor_json, new_items_json, polled_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(source_id) DO UPDATE SET
           cursor_json = excluded.cursor_json,
           new_items_json = excluded.new_items_json,
           polled_at = excluded.polled_at`
      )
      .run(sourceId, JSON.stringify(cursor === undefined ? null : cursor), JSON.stringify(newItems), polledAt);
  }

  /** Every source id that currently has a cached record, regardless of whether its latest poll found anything new. */
  listAll<TItem = unknown>(): WatcherRecord<TItem>[] {
    const rows = this.db.query(`SELECT source_id, new_items_json, polled_at FROM watcher_state`).all() as Row[];
    return rows.map((row) => ({
      sourceId: row.source_id,
      newItems: JSON.parse(row.new_items_json) as TItem[],
      polledAt: row.polled_at ?? "",
    }));
  }

  /** Sources whose latest poll found at least one new item, most-recently-polled first — the common case a note composer actually wants. */
  listWithActivity<TItem = unknown>(): WatcherRecord<TItem>[] {
    return this.listAll<TItem>()
      .filter((record) => record.newItems.length > 0)
      .sort((a, b) => (a.polledAt < b.polledAt ? 1 : a.polledAt > b.polledAt ? -1 : 0));
  }

  close(): void {
    this.db.close();
  }
}
