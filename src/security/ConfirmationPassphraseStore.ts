import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Durable single-value store for the shared confirmation passphrase used
 * by `PassphraseSpeakerAuthenticator` (see SpeakerAuthenticator.ts) — the
 * security layer for proactive, JARVIS-initiated "wake up and speak"
 * reminders (CLAUDE.md wishlist #19). Kept as its own tiny store rather
 * than a column on some other table: this value is security-sensitive,
 * changes rarely, and conceptually has nothing to do with reminders,
 * devices, or any other existing store — it would be a strange fit
 * anywhere else.
 *
 * A single row (fixed id) rather than a table of rows: there is exactly
 * one shared passphrase for the one owner this whole project is built
 * for, not a passphrase per device/user.
 */
export class ConfirmationPassphraseStore {
  private db: Database;

  constructor(dbPath: string = ":memory:") {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    if (dbPath !== ":memory:") this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS confirmation_passphrase (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        passphrase TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  /** The currently configured passphrase, or null if none has ever been set. */
  get(): string | null {
    const row = this.db.query(`SELECT passphrase FROM confirmation_passphrase WHERE id = 1`).get() as
      | { passphrase: string }
      | null;
    return row?.passphrase ?? null;
  }

  /** Sets (or replaces) the passphrase. Always wins over any env-var seed once called — see ConfirmationPassphraseStore.seedIfEmpty. */
  set(passphrase: string): void {
    this.db
      .query(`INSERT OR REPLACE INTO confirmation_passphrase (id, passphrase, updated_at) VALUES (1, ?, ?)`)
      .run(passphrase, new Date().toISOString());
  }

  /**
   * Seeds the passphrase from e.g. `JARVIS_CONFIRMATION_PASSPHRASE` only if
   * none is stored yet — a convenience for a fresh deploy, never an
   * override of a value already explicitly set via `set()`
   * (SET_CONFIRMATION_PASSPHRASE). A no-op when `seed` is undefined/empty.
   */
  seedIfEmpty(seed: string | undefined): void {
    if (!seed) return;
    if (this.get() !== null) return;
    this.set(seed);
  }

  close(): void {
    this.db.close();
  }
}
