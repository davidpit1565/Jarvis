import type { CalendarTokenStore } from "@/calendar/CalendarTokenStore";
import type { DriveFile } from "@/types/drive";
import { fetchWithRetry } from "@/core/net/fetchWithRetry";
import { apiError } from "@/core/net/apiError";

const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";

// Same margin as GoogleCalendarClient/GmailClient, for the same reason:
// refresh a little before actual expiry so a request never straddles it.
const TOKEN_EXPIRY_SAFETY_MARGIN_MS = 60_000;

// Same reasoning as GmailClient/GoogleCalendarClient's own caps.
const MAX_RESULTS_CAP = 25;

const NO_ACCOUNT_LINKED_ERROR = "No Google account linked yet — visit GET /calendar/oauth/start to connect one.";

const DRIVE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

// Fields requested on every Drive files.list/files.get call — just enough
// to build a DriveFile (id/name/webViewLink/mimeType), never the full
// metadata payload Drive can return (permissions, capabilities, etc.)
// which this codebase never uses and would otherwise leak via logs.
const FILE_FIELDS = "id,name,webViewLink,mimeType";

interface RawDriveFile {
  id: string;
  name: string;
  webViewLink?: string;
  mimeType: string;
}

/**
 * Google Drive access via raw fetch calls to the Drive v3 REST API — same
 * no-SDK style as GoogleCalendarClient/GmailClient. Covers: creating a
 * folder, finding/listing files by name (so a later "open the presentation
 * I made yesterday" can resolve back to a real file), searching across ALL
 * of the user's Drive (see searchFiles below), and reading one file's
 * metadata (used by GoogleSlidesClient/GoogleDocsClient to fetch a newly
 * created presentation/document's `webViewLink`, which their own create
 * endpoints don't return).
 *
 * Shares its OAuth tokens with GoogleCalendarClient/GmailClient (same
 * CalendarTokenStore, same Google account link) rather than requiring a
 * separate account link — see GoogleCalendarClient's GOOGLE_SCOPES for the
 * drive.readonly/drive.file/documents/presentations scopes this depends on,
 * and its doc comment for why an already-linked account needs one
 * re-consent before any of this works.
 *
 * Operates over EVERY account CalendarTokenStore has linked, aggregating
 * find/list results across all of them by default (tagging each file with
 * which account it came from) — matching GoogleCalendarClient/GmailClient's
 * own multi-account behavior. A write (create) always targets exactly one
 * account — the explicit `account` argument if given, else whichever
 * account was linked first.
 *
 * getValidAccessToken/resolveAccount are intentionally public (unlike the
 * private copies in GoogleCalendarClient/GmailClient): GoogleSlidesClient
 * and GoogleDocsClient both need a valid access token for the SAME linked
 * account this class already resolves, and duplicating the OAuth
 * refresh/account-resolution logic a third and fourth time would be pure
 * copy-paste with no benefit — they take a GoogleDriveClient instance and
 * reuse this one copy instead.
 */
export class GoogleDriveClient {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly tokenStore: CalendarTokenStore
  ) {}

  /** Every linked account's email, oldest-linked (primary) first. */
  linkedAccounts(): string[] {
    return this.tokenStore.getAll().map((a) => a.email);
  }

  /** The account a write defaults to when none is specified — whichever was linked first — or null if nothing is linked. */
  primaryAccount(): string | null {
    return this.tokenStore.getAll()[0]?.email ?? null;
  }

  private async refreshAccessToken(email: string, refreshToken: string): Promise<string> {
    const response = await fetchWithRetry(GOOGLE_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: "refresh_token",
      }).toString(),
    });

    if (!response.ok) {
      throw await apiError("Google OAuth token refresh failed", response);
    }

    const data = (await response.json()) as { access_token: string; expires_in: number };
    const expiresAt = Date.now() + data.expires_in * 1000;
    this.tokenStore.updateAccessToken(email, data.access_token, expiresAt);
    return data.access_token;
  }

  /** A valid (refreshed if necessary) access token for one linked account. Public — see class doc comment. */
  async getValidAccessToken(email: string): Promise<string> {
    const tokens = this.tokenStore.get(email);
    if (!tokens) {
      throw new Error(`No Google account linked as ${email}.`);
    }

    const stillValid =
      tokens.accessToken !== null &&
      tokens.accessTokenExpiresAt !== null &&
      tokens.accessTokenExpiresAt - TOKEN_EXPIRY_SAFETY_MARGIN_MS > Date.now();

    if (stillValid) return tokens.accessToken!;
    return this.refreshAccessToken(email, tokens.refreshToken);
  }

  /** Resolves which account a write (or an id-less read) should use: the explicit account if given (must actually be linked), else the primary (first-linked) account. Public — see class doc comment. */
  resolveAccount(explicit?: string): string {
    if (explicit) {
      if (!this.tokenStore.isLinked(explicit)) {
        throw new Error(
          `No Google account linked as ${explicit}. Linked accounts: ${this.linkedAccounts().join(", ") || "(none)"}.`
        );
      }
      return explicit;
    }
    const primary = this.primaryAccount();
    if (!primary) throw new Error(NO_ACCOUNT_LINKED_ERROR);
    return primary;
  }

  private mapFile(item: RawDriveFile, account: string): DriveFile {
    return {
      id: item.id,
      name: item.name,
      // Google always returns webViewLink for a real file once it exists;
      // falling back to the Drive web UI's own file-by-id URL only guards
      // against a theoretical missing field rather than one ever actually
      // observed, so a caller never gets back an unusable empty string.
      webViewLink: item.webViewLink ?? `https://drive.google.com/file/d/${item.id}/view`,
      mimeType: item.mimeType,
      account,
    };
  }

  /** One file's metadata by its Drive file id (a Slides presentationId or Docs documentId IS its Drive file id) — used right after creating a presentation/document to get back its real webViewLink, which their own create endpoints don't include. */
  async getFile(fileId: string, account?: string): Promise<DriveFile> {
    const resolvedAccount = this.resolveAccount(account);
    const accessToken = await this.getValidAccessToken(resolvedAccount);
    const url = new URL(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}`);
    url.searchParams.set("fields", FILE_FIELDS);

    const response = await fetchWithRetry(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) {
      throw await apiError("Google Drive file lookup failed", response);
    }
    const item = (await response.json()) as RawDriveFile;
    return this.mapFile(item, resolvedAccount);
  }

  /** Creates a new, empty folder — `account` if given, else whichever account was linked first. */
  async createFolder(name: string, account?: string, parentId?: string): Promise<DriveFile> {
    const resolvedAccount = this.resolveAccount(account);
    const accessToken = await this.getValidAccessToken(resolvedAccount);

    const response = await fetchWithRetry(`${DRIVE_FILES_URL}?fields=${FILE_FIELDS}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        mimeType: DRIVE_FOLDER_MIME_TYPE,
        parents: parentId ? [parentId] : undefined,
      }),
    });

    if (!response.ok) {
      throw await apiError("Google Drive folder creation failed", response);
    }
    const item = (await response.json()) as RawDriveFile;
    return this.mapFile(item, resolvedAccount);
  }

  private async findFilesFor(email: string, name: string, maxResults: number): Promise<DriveFile[]> {
    const accessToken = await this.getValidAccessToken(email);
    const url = new URL(DRIVE_FILES_URL);
    // Escape single quotes/backslashes per Drive's query-string syntax —
    // an unescaped `'` in the search term would otherwise break out of the
    // `name contains '...'` clause and either 400 or (worse) silently
    // change what the query actually matches.
    const escapedName = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    url.searchParams.set("q", `name contains '${escapedName}' and trashed = false`);
    url.searchParams.set("fields", `files(${FILE_FIELDS})`);
    url.searchParams.set("orderBy", "modifiedTime desc");
    url.searchParams.set("pageSize", String(maxResults));

    const response = await fetchWithRetry(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) {
      throw await apiError("Google Drive file search failed", response);
    }
    const data = (await response.json()) as { files?: RawDriveFile[] };
    return (data.files ?? []).map((item) => this.mapFile(item, email));
  }

  /**
   * Files whose name contains `name` (Drive's own `contains` match, not an
   * exact match — matching how someone would actually describe a file:
   * "the presentation I made yesterday" rarely matches a title verbatim),
   * most-recently-modified first, across every linked account (or just
   * `account`, if given). Originally scoped by `drive.file` to only files
   * JARVIS itself created (or the user explicitly opened with it); now that
   * `drive.readonly` is also granted (2026-10-27), the same Drive API call
   * sees the user's whole Drive, same as searchFiles() below — kept as its
   * own method/tool because "find the thing I named X" (a title match) and
   * "search my whole Drive for X" (title or content) are different enough
   * asks to keep as separate, clearly-named tools rather than one
   * do-everything search.
   */
  async findFilesByName(name: string, maxResults: number = 10, account?: string): Promise<DriveFile[]> {
    const capped = Math.min(maxResults, MAX_RESULTS_CAP);
    if (account) {
      this.resolveAccount(account);
      return this.findFilesFor(account, name, capped);
    }

    const accounts = this.tokenStore.getAll();
    if (accounts.length === 0) throw new Error(NO_ACCOUNT_LINKED_ERROR);

    const perAccountResults = await Promise.all(accounts.map((a) => this.findFilesFor(a.email, name, capped)));
    const merged = perAccountResults.flat();
    // Drive doesn't expose modifiedTime in FILE_FIELDS (kept minimal — see
    // its own comment), so re-sorting a merged multi-account list by
    // recency isn't possible without a second field; each account's own
    // list is already most-recent-first, so this just interleaves them in
    // link order rather than claiming a false merged ordering.
    return merged.slice(0, capped);
  }

  private async searchFilesFor(email: string, query: string, maxResults: number): Promise<DriveFile[]> {
    const accessToken = await this.getValidAccessToken(email);
    const url = new URL(DRIVE_FILES_URL);
    // Same escaping reasoning as findFilesFor — an unescaped `'`/`\` in the
    // search term would otherwise break out of the query clauses below.
    const escapedQuery = query.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    // Matches on name OR full text content — broader than findFilesByName's
    // title-only match, which is the point of this method existing now
    // that drive.readonly grants visibility into content, not just names,
    // across the user's whole Drive (not just files JARVIS created).
    url.searchParams.set("q", `(name contains '${escapedQuery}' or fullText contains '${escapedQuery}') and trashed = false`);
    url.searchParams.set("fields", `files(${FILE_FIELDS})`);
    url.searchParams.set("orderBy", "modifiedTime desc");
    url.searchParams.set("pageSize", String(maxResults));

    const response = await fetchWithRetry(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) {
      throw await apiError("Google Drive file search failed", response);
    }
    const data = (await response.json()) as { files?: RawDriveFile[] };
    return (data.files ?? []).map((item) => this.mapFile(item, email));
  }

  /**
   * Searches the user's WHOLE Drive (not just files JARVIS created) by
   * name or file content, most-recently-modified first, across every
   * linked account (or just `account`, if given). Requires the
   * `drive.readonly` scope (added 2026-10-27, see GoogleCalendarClient's
   * GOOGLE_SCOPES) — an account linked before that scope was added needs
   * to re-run GET /calendar/oauth/start to pick it up.
   */
  async searchFiles(query: string, maxResults: number = 10, account?: string): Promise<DriveFile[]> {
    const capped = Math.min(maxResults, MAX_RESULTS_CAP);
    if (account) {
      this.resolveAccount(account);
      return this.searchFilesFor(account, query, capped);
    }

    const accounts = this.tokenStore.getAll();
    if (accounts.length === 0) throw new Error(NO_ACCOUNT_LINKED_ERROR);

    const perAccountResults = await Promise.all(accounts.map((a) => this.searchFilesFor(a.email, query, capped)));
    const merged = perAccountResults.flat();
    // Same reasoning as findFilesByName's own merge: no modifiedTime field
    // to re-sort a merged multi-account list by, so this interleaves
    // already-sorted per-account lists in link order.
    return merged.slice(0, capped);
  }
}
