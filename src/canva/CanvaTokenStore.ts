import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface CanvaTokens {
  refreshToken: string;
  accessToken: string | null;
  /** Epoch milliseconds the access token expires at, or null if never fetched yet. */
  accessTokenExpiresAt: number | null;
}

const SINGLETON_ID = "canva";

/**
 * Persists the single linked Canva account's OAuth tokens — a single-row
 * store (there's only ever one linked account for this single-user
 * assistant), separate from every other SQLite store so it can be backed
 * up/reset independently and so its sensitive refresh token never mixes
 * with any other data. Same shape and reasoning as SpotifyTokenStore/
 * CalendarTokenStore.
 *
 * Unlike Spotify (which only *sometimes* rotates the refresh token on a
 * refresh grant), Canva's own docs are explicit that "each refresh token
 * can only be used once" and a refresh-grant response "always" includes a
 * new one — so, unlike SpotifyTokenStore.updateAccessToken, this store's
 * equivalent method takes the new refresh token as a required parameter,
 * not an optional one. Forgetting to persist it here would make every
 * subsequent refresh fail with invalid_grant after exactly one use.
 */
export class CanvaTokenStore {
  private db: Database;

  constructor(dbPath: string = ":memory:") {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    if (dbPath !== ":memory:") this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS canva_tokens (
        id TEXT PRIMARY KEY,
        refresh_token TEXT NOT NULL,
        access_token TEXT,
        access_token_expires_at INTEGER
      )
    `);
  }

  /** Upserts the linked account's tokens — completing the OAuth flow again replaces whatever was there before. */
  save(tokens: CanvaTokens): void {
    this.db
      .query(
        `INSERT INTO canva_tokens (id, refresh_token, access_token, access_token_expires_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET refresh_token = excluded.refresh_token, access_token = excluded.access_token,
           access_token_expires_at = excluded.access_token_expires_at`
      )
      .run(SINGLETON_ID, tokens.refreshToken, tokens.accessToken, tokens.accessTokenExpiresAt);
  }

  /**
   * Updates the access token after a refresh. `newRefreshToken` is
   * required (see class doc comment) — Canva always rotates it on a
   * refresh grant, and the old one becomes permanently invalid once that
   * happens.
   */
  updateAccessToken(accessToken: string, expiresAt: number, newRefreshToken: string): void {
    this.db
      .query(`UPDATE canva_tokens SET access_token = ?, access_token_expires_at = ?, refresh_token = ? WHERE id = ?`)
      .run(accessToken, expiresAt, newRefreshToken, SINGLETON_ID);
  }

  get(): CanvaTokens | null {
    const row = this.db
      .query(
        `SELECT refresh_token as refreshToken, access_token as accessToken, access_token_expires_at as accessTokenExpiresAt
         FROM canva_tokens WHERE id = ?`
      )
      .get(SINGLETON_ID) as CanvaTokens | null;
    return row ?? null;
  }

  isLinked(): boolean {
    return this.get() !== null;
  }

  /** Unlinks the account — a fresh /canva/oauth/start is required to reconnect. */
  clear(): void {
    this.db.query(`DELETE FROM canva_tokens WHERE id = ?`).run(SINGLETON_ID);
  }

  close(): void {
    this.db.close();
  }
}
