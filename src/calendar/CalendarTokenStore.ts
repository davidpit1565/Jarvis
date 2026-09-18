import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface CalendarTokens {
  refreshToken: string;
  accessToken: string | null;
  /** Epoch milliseconds the access token expires at, or null if never fetched yet. */
  accessTokenExpiresAt: number | null;
}

const SINGLETON_ID = "google";

/**
 * Persists the single Google account's OAuth tokens for calendar access —
 * a single-row store (there's only ever one linked account for this
 * single-user assistant), separate from every other SQLite store so it
 * can be backed up/reset independently and so its sensitive refresh token
 * never mixes with any other data. Distinct from WebAuthnStore: this is
 * OAuth credentials to a third-party API, not a local biometric credential.
 */
export class CalendarTokenStore {
  private db: Database;

  constructor(dbPath: string = ":memory:") {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    if (dbPath !== ":memory:") this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS calendar_tokens (
        id TEXT PRIMARY KEY,
        refresh_token TEXT NOT NULL,
        access_token TEXT,
        access_token_expires_at INTEGER
      )
    `);
  }

  /** Upserts the linked account's tokens — completing the OAuth flow again replaces whatever was there before. */
  save(tokens: CalendarTokens): void {
    this.db
      .query(
        `INSERT INTO calendar_tokens (id, refresh_token, access_token, access_token_expires_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET refresh_token = excluded.refresh_token, access_token = excluded.access_token,
           access_token_expires_at = excluded.access_token_expires_at`
      )
      .run(SINGLETON_ID, tokens.refreshToken, tokens.accessToken, tokens.accessTokenExpiresAt);
  }

  /** Updates just the access token after a refresh — the refresh token itself doesn't change. */
  updateAccessToken(accessToken: string, expiresAt: number): void {
    this.db
      .query(`UPDATE calendar_tokens SET access_token = ?, access_token_expires_at = ? WHERE id = ?`)
      .run(accessToken, expiresAt, SINGLETON_ID);
  }

  get(): CalendarTokens | null {
    const row = this.db
      .query(
        `SELECT refresh_token as refreshToken, access_token as accessToken, access_token_expires_at as accessTokenExpiresAt
         FROM calendar_tokens WHERE id = ?`
      )
      .get(SINGLETON_ID) as CalendarTokens | null;
    return row ?? null;
  }

  isLinked(): boolean {
    return this.get() !== null;
  }

  /** Unlinks the account — a fresh /calendar/oauth/start is required to reconnect. */
  clear(): void {
    this.db.query(`DELETE FROM calendar_tokens WHERE id = ?`).run(SINGLETON_ID);
  }

  close(): void {
    this.db.close();
  }
}
