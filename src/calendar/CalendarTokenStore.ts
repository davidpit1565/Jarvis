import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface CalendarTokens {
  refreshToken: string;
  accessToken: string | null;
  /** Epoch milliseconds the access token expires at, or null if never fetched yet. */
  accessTokenExpiresAt: number | null;
}

export interface LinkedGoogleAccount extends CalendarTokens {
  /** The linked Google account's own email address — this row's key. */
  email: string;
  /** Epoch milliseconds this account was first linked — getAll() orders by this, oldest (primary) first. */
  linkedAt: number;
}

// Placeholder key a row migrated from the old single-account schema is
// given until its real email is fetched and it's re-keyed (see rekey()
// and GoogleCalendarClient.backfillLegacyAccountEmails()). Deliberately
// not a valid email address (no "@") so it can never collide with a real
// linked account, and is trivial to detect.
const LEGACY_PLACEHOLDER_EMAIL = "google";

// Email addresses are universally case-insensitive, but every lookup here
// is a raw SQLite TEXT comparison (case-sensitive/BINARY by default) — a
// linked account stored as whatever casing Google's userinfo endpoint
// returned (commonly lowercase) would otherwise silently fail to match a
// caller who supplies (or a model who composes) the same address with
// different casing, e.g. "Alice@Gmail.com" vs the stored "alice@gmail.com".
// Normalizing at every boundary here makes every account keyed and looked
// up consistently, regardless of the casing any caller passes in.
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Persists every linked Google account's OAuth tokens for Calendar/Gmail
 * access, one row per account, keyed by the account's own email address —
 * JARVIS links up to a handful of real Google accounts (work, personal,
 * etc.), not just one. Separate from every other SQLite store so it can
 * be backed up/reset independently and so refresh tokens never mix with
 * any other data. Distinct from WebAuthnStore: this is OAuth credentials
 * to a third-party API, not a local biometric credential.
 *
 * Was previously a true singleton (a fixed `id = "google"` row) — see
 * migrateLegacySingletonSchema() for the one-time, additive migration
 * that carries an existing installation's single linked account forward
 * into this schema without losing it.
 */
export class CalendarTokenStore {
  private db: Database;

  constructor(dbPath: string = ":memory:") {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    if (dbPath !== ":memory:") this.db.run("PRAGMA journal_mode = WAL");
    this.migrateLegacySingletonSchema();
    this.db.run(`
      CREATE TABLE IF NOT EXISTS calendar_tokens (
        email TEXT PRIMARY KEY,
        refresh_token TEXT NOT NULL,
        access_token TEXT,
        access_token_expires_at INTEGER,
        linked_at INTEGER NOT NULL
      )
    `);
  }

  /**
   * One-time, additive migration off the old single-row schema
   * (`calendar_tokens(id TEXT PRIMARY KEY, ...)`, fixed at `id = "google"`)
   * onto this one — this codebase's usual additive-migration pattern
   * (`PRAGMA table_info` to detect the old shape, then migrate, never a
   * silent drop). A no-op for a brand-new database (no `calendar_tokens`
   * table yet — `CREATE TABLE IF NOT EXISTS` below makes the new one
   * directly) and a no-op once already migrated (the table already has an
   * `email` column). The migrated row keeps its refresh/access tokens
   * intact under the placeholder key `"google"` — its *real* email isn't
   * knowable synchronously here (that needs a network call to Google's
   * userinfo endpoint) — until GoogleCalendarClient.backfillLegacyAccountEmails()
   * fetches it and calls rekey() shortly after startup.
   */
  private migrateLegacySingletonSchema(): void {
    const columns = this.db.query(`PRAGMA table_info(calendar_tokens)`).all() as Array<{ name: string }>;
    if (columns.length === 0) return; // no table yet
    const alreadyMigrated = columns.some((c) => c.name === "email");
    if (alreadyMigrated) return;

    this.db.run("ALTER TABLE calendar_tokens RENAME TO calendar_tokens_legacy_v1");
    this.db.run(`
      CREATE TABLE calendar_tokens (
        email TEXT PRIMARY KEY,
        refresh_token TEXT NOT NULL,
        access_token TEXT,
        access_token_expires_at INTEGER,
        linked_at INTEGER NOT NULL
      )
    `);
    const legacyRows = this.db
      .query(`SELECT id, refresh_token, access_token, access_token_expires_at FROM calendar_tokens_legacy_v1`)
      .all() as Array<{ id: string; refresh_token: string; access_token: string | null; access_token_expires_at: number | null }>;

    const now = Date.now();
    for (const row of legacyRows) {
      this.db
        .query(
          `INSERT INTO calendar_tokens (email, refresh_token, access_token, access_token_expires_at, linked_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(LEGACY_PLACEHOLDER_EMAIL, row.refresh_token, row.access_token, row.access_token_expires_at, now);
    }
    this.db.run("DROP TABLE calendar_tokens_legacy_v1");
  }

  /**
   * Upserts one linked account's tokens, keyed by its Google email —
   * completing the OAuth flow again for the SAME account (re-consenting,
   * refreshing scopes) updates its row in place; linking a DIFFERENT
   * account is additive and never touches this or any other account's
   * row. `linked_at` is only set the first time an email is seen, so
   * re-linking never changes that account's place in link order.
   */
  save(email: string, tokens: CalendarTokens): void {
    this.db
      .query(
        `INSERT INTO calendar_tokens (email, refresh_token, access_token, access_token_expires_at, linked_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET refresh_token = excluded.refresh_token, access_token = excluded.access_token,
           access_token_expires_at = excluded.access_token_expires_at`
      )
      .run(normalizeEmail(email), tokens.refreshToken, tokens.accessToken, tokens.accessTokenExpiresAt, Date.now());
  }

  /** Updates just one account's access token after a refresh — its refresh token and link order are untouched. */
  updateAccessToken(email: string, accessToken: string, expiresAt: number): void {
    this.db
      .query(`UPDATE calendar_tokens SET access_token = ?, access_token_expires_at = ? WHERE email = ?`)
      .run(accessToken, expiresAt, normalizeEmail(email));
  }

  get(email: string): LinkedGoogleAccount | null {
    const row = this.db
      .query(
        `SELECT email, refresh_token as refreshToken, access_token as accessToken,
           access_token_expires_at as accessTokenExpiresAt, linked_at as linkedAt
         FROM calendar_tokens WHERE email = ?`
      )
      .get(normalizeEmail(email)) as LinkedGoogleAccount | null;
    return row ?? null;
  }

  /** Every linked account, oldest-linked first — index 0 is the "primary" account writes default to when none is specified. */
  getAll(): LinkedGoogleAccount[] {
    return this.db
      .query(
        `SELECT email, refresh_token as refreshToken, access_token as accessToken,
           access_token_expires_at as accessTokenExpiresAt, linked_at as linkedAt
         FROM calendar_tokens ORDER BY linked_at ASC`
      )
      .all() as LinkedGoogleAccount[];
  }

  /** Rows carried over from the old singleton schema whose real email hasn't been fetched/backfilled yet — see rekey(). */
  listAccountsNeedingEmailBackfill(): LinkedGoogleAccount[] {
    return this.getAll().filter((a) => a.email === LEGACY_PLACEHOLDER_EMAIL);
  }

  /** Re-keys a migrated legacy row onto the account's real, now-fetched email — same tokens, same link order, just its real identity. */
  rekey(oldEmail: string, newEmail: string): void {
    this.db.query(`UPDATE calendar_tokens SET email = ? WHERE email = ?`).run(normalizeEmail(newEmail), normalizeEmail(oldEmail));
  }

  isLinked(email: string): boolean {
    return this.get(email) !== null;
  }

  /** How many Google accounts are currently linked. */
  count(): number {
    return (this.db.query(`SELECT COUNT(*) as n FROM calendar_tokens`).get() as { n: number }).n;
  }

  /** Unlinks one account — a fresh /calendar/oauth/start (choosing that Google account at the consent screen) is required to reconnect it. */
  delete(email: string): void {
    this.db.query(`DELETE FROM calendar_tokens WHERE email = ?`).run(normalizeEmail(email));
  }

  close(): void {
    this.db.close();
  }
}
