import type { CalendarTokenStore } from "@/calendar/CalendarTokenStore";
import type { CalendarEvent, CalendarEventDetail, CreateCalendarEventInput } from "@/types/calendar";

const GOOGLE_OAUTH_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
// Identifies which Google account just authorized JARVIS — used right
// after the OAuth token exchange to key CalendarTokenStore by the
// account's own email rather than a fixed placeholder id, so linking a
// second/third account is additive (a new row) instead of overwriting
// whichever account was linked before.
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const GOOGLE_CALENDAR_EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
// Full read/write access — not just calendar.readonly. JARVIS creating an
// event on request is a real, requested feature; the tool layer (CONFIRM
// permission level) is what actually gates when that's allowed to happen,
// not the OAuth scope.
//
// Also requests gmail.readonly + gmail.send in the same consent grant:
// linking a Google account once covers both Calendar and Gmail (see
// src/gmail/GmailClient.ts), rather than sending the user through two
// separate OAuth flows for the same account. gmail.send is scoped to
// sending only — it does not grant delete or arbitrary mailbox
// modification — and was added on the user's own explicit request,
// reversing this feature's original read-only-by-design boundary.
// Existing linked accounts need to re-run GET /calendar/oauth/start to
// pick up the new scope; a stored refresh token minted under the old,
// narrower scope will keep working for Calendar/read Gmail but Gmail send
// calls will fail with an insufficient-scope error until they do.
const GOOGLE_SCOPES =
  "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send";

// Refresh a little before actual expiry, so a request never straddles the
// exact expiry instant and gets rejected mid-flight by Google's clock
// rather than ours.
const TOKEN_EXPIRY_SAFETY_MARGIN_MS = 60_000;

// Same reasoning as GmailClient's own cap: a caller passing an
// unreasonably large maxResults shouldn't be able to pull an unbounded
// number of events (and their full field set) in one request. Applied
// per-account when aggregating across multiple linked accounts, then the
// MERGED result is capped again to the caller's own maxResults.
const MAX_RESULTS_CAP = 50;

const NO_ACCOUNT_LINKED_ERROR = "No Google account linked yet — visit GET /calendar/oauth/start to connect one.";

interface RawGoogleEvent {
  id: string;
  summary?: string;
  location?: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
}

interface RawGoogleEventDetail extends RawGoogleEvent {
  description?: string;
  attendees?: Array<{ email: string }>;
}

/**
 * Google Calendar access via raw fetch calls to Google's OAuth2 and
 * Calendar v3 REST APIs — no SDK dependency, matching this project's
 * existing style (see TwilioOutboundCaller). Supports both reading and
 * creating events; the tool layer (READ vs. CONFIRM permission level) is
 * what actually gates when each is allowed to happen, not this class.
 *
 * Operates over EVERY account CalendarTokenStore has linked, not just
 * one: every read/search method aggregates across all linked accounts by
 * default (tagging each returned event with which account it came from),
 * so the caller never has to say which account they mean. A write
 * (create/update/delete) always targets exactly one account — the
 * explicit `account` argument if given, else whichever account was
 * linked first (see `primaryAccount()`); update/delete additionally
 * resolve which account an existing event id belongs to when the caller
 * doesn't already know (see `resolveAccountForEvent`).
 */
export class GoogleCalendarClient {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
    private readonly tokenStore: CalendarTokenStore
  ) {}

  /** The URL to send the user to for Google's consent screen. `state` is echoed back on the callback for CSRF protection. Re-running this and picking a DIFFERENT Google account at the consent screen is how a second/third account gets linked — Google's own "use another account" option, nothing JARVIS-specific needed. */
  buildAuthUrl(state: string): string {
    const url = new URL(GOOGLE_OAUTH_AUTHORIZE_URL);
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", GOOGLE_SCOPES);
    // offline + consent: without both, Google may not issue a refresh
    // token at all on a repeat authorization, silently leaving JARVIS
    // unable to refresh access after the short-lived access token expires.
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("state", state);
    return url.toString();
  }

  /** Every linked account's email, oldest-linked (primary) first. */
  linkedAccounts(): string[] {
    return this.tokenStore.getAll().map((a) => a.email);
  }

  /** The account a write defaults to when none is specified — whichever was linked first — or null if nothing is linked. */
  primaryAccount(): string | null {
    return this.tokenStore.getAll()[0]?.email ?? null;
  }

  /**
   * Exchanges an OAuth authorization code for tokens, identifies which
   * Google account they belong to via the userinfo endpoint, and
   * saves/updates that ONE account's row (an existing different account's
   * tokens are never touched). Returns the linked account's email.
   */
  async exchangeCodeForTokens(code: string): Promise<string> {
    const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: this.redirectUri,
        grant_type: "authorization_code",
      }).toString(),
    });

    if (!response.ok) {
      throw new Error(`Google OAuth code exchange failed (${response.status}): ${await response.text().catch(() => "")}`);
    }

    const data = (await response.json()) as { access_token: string; refresh_token?: string; expires_in: number };
    if (!data.refresh_token) {
      throw new Error(
        "Google didn't return a refresh token — this happens if the account already granted access before " +
          "without prompt=consent forcing a fresh grant. Revoke JARVIS's access at " +
          "https://myaccount.google.com/permissions and try linking again."
      );
    }

    const email = await this.fetchAccountEmail(data.access_token);
    this.tokenStore.save(email, {
      refreshToken: data.refresh_token,
      accessToken: data.access_token,
      accessTokenExpiresAt: Date.now() + data.expires_in * 1000,
    });
    return email;
  }

  /** Looks up the Google account's own email via its userinfo endpoint, given a valid access token for it. */
  private async fetchAccountEmail(accessToken: string): Promise<string> {
    const response = await fetch(GOOGLE_USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) {
      throw new Error(`Google userinfo request failed (${response.status}): ${await response.text().catch(() => "")}`);
    }
    const data = (await response.json()) as { email?: string };
    if (!data.email) {
      throw new Error("Google's userinfo response didn't include an email address — cannot identify the linked account.");
    }
    return data.email;
  }

  /**
   * Migrates any row CalendarTokenStore carried over from the old
   * single-account schema (kept under a placeholder key there — see its
   * own doc comment) onto its real email, by refreshing/using its access
   * token to call Google's userinfo endpoint. A no-op once there's
   * nothing left to backfill. Meant to be called once, right after
   * construction (see src/index.ts); swallows its own errors (logged, not
   * thrown) so a transient network failure at boot never blocks JARVIS
   * from starting — an un-backfilled account keeps working for
   * Calendar/Gmail exactly as before, it's just not identifiable by email
   * (and therefore not addressable as a specific `account`) until this
   * succeeds on some later call.
   */
  async backfillLegacyAccountEmails(): Promise<void> {
    for (const legacy of this.tokenStore.listAccountsNeedingEmailBackfill()) {
      try {
        const accessToken = await this.getValidAccessToken(legacy.email);
        const email = await this.fetchAccountEmail(accessToken);
        if (email !== legacy.email) this.tokenStore.rekey(legacy.email, email);
      } catch (err) {
        console.error(
          "[jarvis] Could not identify a legacy-linked Google account's real email yet — it stays linked and " +
            "keeps working, this just means it can't be targeted by email as a specific `account` until it " +
            "succeeds on a later attempt:",
          err instanceof Error ? err.message : String(err)
        );
      }
    }
  }

  private async refreshAccessToken(email: string, refreshToken: string): Promise<string> {
    const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
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
      throw new Error(`Google OAuth token refresh failed (${response.status}): ${await response.text().catch(() => "")}`);
    }

    const data = (await response.json()) as { access_token: string; expires_in: number };
    const expiresAt = Date.now() + data.expires_in * 1000;
    this.tokenStore.updateAccessToken(email, data.access_token, expiresAt);
    return data.access_token;
  }

  private async getValidAccessToken(email: string): Promise<string> {
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

  /** Resolves which account a write (or an id-less read) should use: the explicit account if given (must actually be linked), else the primary (first-linked) account. Throws a clear error if nothing is linked at all. */
  private resolveAccount(explicit?: string): string {
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

  /**
   * Resolves which linked account an EXISTING event by id belongs to, for
   * update/delete when the caller doesn't already know (e.g. it wasn't
   * carried over from a prior list/search result's `account` field). With
   * a single linked account this is free — that's the only place the
   * event can possibly be. With more than one, it probes each account's
   * GET in link order and uses the first that finds the event; throws a
   * combined "not found anywhere" error (naming every account it tried)
   * if none do.
   */
  private async resolveAccountForEvent(eventId: string, explicit?: string): Promise<string> {
    if (explicit) return this.resolveAccount(explicit);

    const accounts = this.tokenStore.getAll();
    if (accounts.length === 0) throw new Error(NO_ACCOUNT_LINKED_ERROR);
    if (accounts.length === 1) return accounts[0]!.email;

    const triedEmails: string[] = [];
    for (const account of accounts) {
      triedEmails.push(account.email);
      try {
        await this.fetchEventRaw(eventId, account.email);
        return account.email;
      } catch {
        // Not in this account — try the next one.
      }
    }
    throw new Error(
      `Could not find event "${eventId}" in any linked account (tried: ${triedEmails.join(", ")}). ` +
        "Pass the account explicitly if you know which one it's in."
    );
  }

  private async fetchEventRaw(eventId: string, email: string): Promise<RawGoogleEventDetail> {
    const accessToken = await this.getValidAccessToken(email);
    const response = await fetch(`${GOOGLE_CALENDAR_EVENTS_URL}/${encodeURIComponent(eventId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      throw new Error(`Google Calendar API request failed (${response.status}): ${await response.text().catch(() => "")}`);
    }
    return (await response.json()) as RawGoogleEventDetail;
  }

  private mapEvent(item: RawGoogleEvent, account: string): CalendarEvent {
    return {
      id: item.id,
      summary: item.summary ?? "(no title)",
      start: item.start.dateTime ?? item.start.date ?? "",
      end: item.end.dateTime ?? item.end.date ?? "",
      location: item.location ?? null,
      account,
    };
  }

  private async fetchEventsFor(email: string, params: URLSearchParams): Promise<CalendarEvent[]> {
    const accessToken = await this.getValidAccessToken(email);
    const url = new URL(GOOGLE_CALENDAR_EVENTS_URL);
    for (const [key, value] of params) url.searchParams.set(key, value);

    const response = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) {
      throw new Error(`Google Calendar API request failed (${response.status}): ${await response.text().catch(() => "")}`);
    }
    const data = (await response.json()) as { items: RawGoogleEvent[] };
    return (data.items ?? []).map((item) => this.mapEvent(item, email));
  }

  /**
   * Runs a listing/search query against just `account` if given, else
   * every linked account, merging the results and tagging each event
   * with which account it came from — the default, no-account-specified
   * behavior every read tool relies on, so the user never has to say
   * which account they mean. Sorted soonest-first (matching Google's own
   * `orderBy=startTime`) and capped to `maxResults` AFTER merging, so
   * aggregating across accounts never returns more than what a single
   * account would have.
   */
  private async fetchAcrossAccounts(
    account: string | undefined,
    maxResults: number,
    buildParams: (perAccountCap: number) => URLSearchParams
  ): Promise<CalendarEvent[]> {
    if (account) {
      this.resolveAccount(account);
      return this.fetchEventsFor(account, buildParams(maxResults));
    }

    const accounts = this.tokenStore.getAll();
    if (accounts.length === 0) throw new Error(NO_ACCOUNT_LINKED_ERROR);

    const perAccountCap = Math.min(maxResults, MAX_RESULTS_CAP);
    const perAccountResults = await Promise.all(accounts.map((a) => this.fetchEventsFor(a.email, buildParams(perAccountCap))));
    const merged = perAccountResults.flat();
    merged.sort((a, b) => Date.parse(a.start || "") - Date.parse(b.start || ""));
    return merged.slice(0, maxResults);
  }

  /** Upcoming events starting from now, soonest first, across every linked account (or just `account`, if given). */
  async listUpcomingEvents(maxResults: number = 10, account?: string): Promise<CalendarEvent[]> {
    const capped = Math.min(maxResults, MAX_RESULTS_CAP);
    return this.fetchAcrossAccounts(account, capped, (perAccountCap) => {
      const params = new URLSearchParams();
      params.set("timeMin", new Date().toISOString());
      params.set("maxResults", String(perAccountCap));
      params.set("singleEvents", "true");
      params.set("orderBy", "startTime");
      return params;
    });
  }

  /** Events overlapping [startIso, endIso), for detecting a scheduling conflict before creating a new event — across every linked account (or just `account`, if given). */
  async listEventsInRange(startIso: string, endIso: string, account?: string): Promise<CalendarEvent[]> {
    return this.fetchAcrossAccounts(account, MAX_RESULTS_CAP, () => {
      const params = new URLSearchParams();
      params.set("timeMin", startIso);
      params.set("timeMax", endIso);
      params.set("singleEvents", "true");
      params.set("orderBy", "startTime");
      return params;
    });
  }

  /** Events matching a free-text query (Google's own `q` search over summary/description/location/attendees), soonest first, not limited to upcoming ones — across every linked account (or just `account`, if given). */
  async searchEvents(query: string, maxResults: number = 10, account?: string): Promise<CalendarEvent[]> {
    const capped = Math.min(maxResults, MAX_RESULTS_CAP);
    return this.fetchAcrossAccounts(account, capped, (perAccountCap) => {
      const params = new URLSearchParams();
      params.set("q", query);
      params.set("maxResults", String(perAccountCap));
      params.set("singleEvents", "true");
      params.set("orderBy", "startTime");
      return params;
    });
  }

  /** One event's full detail by id, including description and attendees — not returned by list/search. Searches every linked account for it unless `account` is given. */
  async getEvent(eventId: string, account?: string): Promise<CalendarEventDetail> {
    const resolvedAccount = await this.resolveAccountForEvent(eventId, account);
    const item = await this.fetchEventRaw(eventId, resolvedAccount);
    return {
      ...this.mapEvent(item, resolvedAccount),
      description: item.description ?? null,
      attendees: (item.attendees ?? []).map((a) => a.email),
    };
  }

  /** Creates a new event on one account's primary calendar — `account` if given, else whichever account was linked first. Returns the created event. */
  async createEvent(input: CreateCalendarEventInput, account?: string): Promise<CalendarEvent> {
    const resolvedAccount = this.resolveAccount(account);
    const accessToken = await this.getValidAccessToken(resolvedAccount);

    const response = await fetch(GOOGLE_CALENDAR_EVENTS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        summary: input.summary,
        location: input.location ?? undefined,
        start: { dateTime: input.start },
        end: { dateTime: input.end },
      }),
    });

    if (!response.ok) {
      throw new Error(`Google Calendar event creation failed (${response.status}): ${await response.text().catch(() => "")}`);
    }

    const item = (await response.json()) as RawGoogleEvent;
    return this.mapEvent(item, resolvedAccount);
  }

  /**
   * Edits an existing event's summary/time/location in place via a PATCH
   * (only the given fields are sent, so anything unset here — like
   * attendees — is left untouched by Google) — without this, the only
   * way to change anything about an event was delete-then-recreate,
   * which loses its id and drops attendees/description for no reason.
   * Resolves which account the event belongs to the same way getEvent()
   * does, unless `account` is given explicitly.
   */
  async updateEvent(
    eventId: string,
    changes: { summary?: string; start?: string; end?: string; location?: string | null },
    account?: string
  ): Promise<CalendarEvent> {
    const resolvedAccount = await this.resolveAccountForEvent(eventId, account);
    const accessToken = await this.getValidAccessToken(resolvedAccount);

    const body: Record<string, unknown> = {};
    if (changes.summary !== undefined) body.summary = changes.summary;
    if (changes.start !== undefined) body.start = { dateTime: changes.start };
    if (changes.end !== undefined) body.end = { dateTime: changes.end };
    if (changes.location !== undefined) body.location = changes.location ?? "";

    const response = await fetch(`${GOOGLE_CALENDAR_EVENTS_URL}/${encodeURIComponent(eventId)}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Google Calendar event update failed (${response.status}): ${await response.text().catch(() => "")}`);
    }

    const item = (await response.json()) as RawGoogleEvent;
    return this.mapEvent(item, resolvedAccount);
  }

  /** Deletes an event by its id, from whichever linked account it belongs to (resolved the same way as getEvent()/updateEvent(), unless `account` is given explicitly). */
  async deleteEvent(eventId: string, account?: string): Promise<void> {
    const resolvedAccount = await this.resolveAccountForEvent(eventId, account);
    const accessToken = await this.getValidAccessToken(resolvedAccount);

    const response = await fetch(`${GOOGLE_CALENDAR_EVENTS_URL}/${encodeURIComponent(eventId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    // Google returns 204 on success and 410 if the event was already
    // deleted — both mean "the event isn't there anymore," which is what
    // the caller wanted, so 410 isn't treated as failure.
    if (!response.ok && response.status !== 410) {
      throw new Error(`Google Calendar event deletion failed (${response.status}): ${await response.text().catch(() => "")}`);
    }
  }
}
