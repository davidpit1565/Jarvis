import type { CalendarTokenStore } from "@/calendar/CalendarTokenStore";
import type { CalendarEvent, CalendarEventDetail, CreateCalendarEventInput } from "@/types/calendar";

const GOOGLE_OAUTH_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
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
// number of events (and their full field set) in one request.
const MAX_RESULTS_CAP = 50;

/**
 * Google Calendar access via raw fetch calls to Google's OAuth2 and
 * Calendar v3 REST APIs — no SDK dependency, matching this project's
 * existing style (see TwilioOutboundCaller). Supports both reading and
 * creating events; the tool layer (READ vs. CONFIRM permission level) is
 * what actually gates when each is allowed to happen, not this class.
 */
export class GoogleCalendarClient {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
    private readonly tokenStore: CalendarTokenStore
  ) {}

  /** The URL to send the user to for Google's consent screen. `state` is echoed back on the callback for CSRF protection. */
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

  /** Exchanges an OAuth authorization code for tokens and persists them. */
  async exchangeCodeForTokens(code: string): Promise<void> {
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

    this.tokenStore.save({
      refreshToken: data.refresh_token,
      accessToken: data.access_token,
      accessTokenExpiresAt: Date.now() + data.expires_in * 1000,
    });
  }

  private async refreshAccessToken(refreshToken: string): Promise<string> {
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
    this.tokenStore.updateAccessToken(data.access_token, expiresAt);
    return data.access_token;
  }

  private async getValidAccessToken(): Promise<string> {
    const tokens = this.tokenStore.get();
    if (!tokens) {
      throw new Error("No Google account linked yet — visit GET /calendar/oauth/start to connect one.");
    }

    const stillValid =
      tokens.accessToken !== null &&
      tokens.accessTokenExpiresAt !== null &&
      tokens.accessTokenExpiresAt - TOKEN_EXPIRY_SAFETY_MARGIN_MS > Date.now();

    if (stillValid) return tokens.accessToken!;
    return this.refreshAccessToken(tokens.refreshToken);
  }

  /** Upcoming events starting from now, soonest first. */
  async listUpcomingEvents(maxResults: number = 10): Promise<CalendarEvent[]> {
    const accessToken = await this.getValidAccessToken();

    const url = new URL(GOOGLE_CALENDAR_EVENTS_URL);
    url.searchParams.set("timeMin", new Date().toISOString());
    url.searchParams.set("maxResults", String(Math.min(maxResults, MAX_RESULTS_CAP)));
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");

    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      throw new Error(`Google Calendar API request failed (${response.status}): ${await response.text().catch(() => "")}`);
    }

    const data = (await response.json()) as {
      items: Array<{
        id: string;
        summary?: string;
        location?: string;
        start: { dateTime?: string; date?: string };
        end: { dateTime?: string; date?: string };
      }>;
    };

    return (data.items ?? []).map((item) => ({
      id: item.id,
      summary: item.summary ?? "(no title)",
      start: item.start.dateTime ?? item.start.date ?? "",
      end: item.end.dateTime ?? item.end.date ?? "",
      location: item.location ?? null,
    }));
  }

  /** Events overlapping [startIso, endIso), for detecting a scheduling conflict before creating a new event. */
  async listEventsInRange(startIso: string, endIso: string): Promise<CalendarEvent[]> {
    const accessToken = await this.getValidAccessToken();

    const url = new URL(GOOGLE_CALENDAR_EVENTS_URL);
    url.searchParams.set("timeMin", startIso);
    url.searchParams.set("timeMax", endIso);
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");

    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      throw new Error(`Google Calendar API request failed (${response.status}): ${await response.text().catch(() => "")}`);
    }

    const data = (await response.json()) as {
      items: Array<{
        id: string;
        summary?: string;
        location?: string;
        start: { dateTime?: string; date?: string };
        end: { dateTime?: string; date?: string };
      }>;
    };

    return (data.items ?? []).map((item) => ({
      id: item.id,
      summary: item.summary ?? "(no title)",
      start: item.start.dateTime ?? item.start.date ?? "",
      end: item.end.dateTime ?? item.end.date ?? "",
      location: item.location ?? null,
    }));
  }

  /** Events matching a free-text query (Google's own `q` search over summary/description/location/attendees), soonest first, not limited to upcoming ones. */
  async searchEvents(query: string, maxResults: number = 10): Promise<CalendarEvent[]> {
    const accessToken = await this.getValidAccessToken();

    const url = new URL(GOOGLE_CALENDAR_EVENTS_URL);
    url.searchParams.set("q", query);
    url.searchParams.set("maxResults", String(Math.min(maxResults, MAX_RESULTS_CAP)));
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");

    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      throw new Error(`Google Calendar API request failed (${response.status}): ${await response.text().catch(() => "")}`);
    }

    const data = (await response.json()) as {
      items: Array<{
        id: string;
        summary?: string;
        location?: string;
        start: { dateTime?: string; date?: string };
        end: { dateTime?: string; date?: string };
      }>;
    };

    return (data.items ?? []).map((item) => ({
      id: item.id,
      summary: item.summary ?? "(no title)",
      start: item.start.dateTime ?? item.start.date ?? "",
      end: item.end.dateTime ?? item.end.date ?? "",
      location: item.location ?? null,
    }));
  }

  /** One event's full detail by id, including description and attendees — not returned by list/search. */
  async getEvent(eventId: string): Promise<CalendarEventDetail> {
    const accessToken = await this.getValidAccessToken();

    const response = await fetch(`${GOOGLE_CALENDAR_EVENTS_URL}/${encodeURIComponent(eventId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      throw new Error(`Google Calendar API request failed (${response.status}): ${await response.text().catch(() => "")}`);
    }

    const item = (await response.json()) as {
      id: string;
      summary?: string;
      description?: string;
      location?: string;
      start: { dateTime?: string; date?: string };
      end: { dateTime?: string; date?: string };
      attendees?: Array<{ email: string }>;
    };

    return {
      id: item.id,
      summary: item.summary ?? "(no title)",
      start: item.start.dateTime ?? item.start.date ?? "",
      end: item.end.dateTime ?? item.end.date ?? "",
      location: item.location ?? null,
      description: item.description ?? null,
      attendees: (item.attendees ?? []).map((a) => a.email),
    };
  }

  /** Creates a new event on the user's primary calendar. Returns the created event. */
  async createEvent(input: CreateCalendarEventInput): Promise<CalendarEvent> {
    const accessToken = await this.getValidAccessToken();

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

    const item = (await response.json()) as {
      id: string;
      summary?: string;
      location?: string;
      start: { dateTime?: string; date?: string };
      end: { dateTime?: string; date?: string };
    };

    return {
      id: item.id,
      summary: item.summary ?? "(no title)",
      start: item.start.dateTime ?? item.start.date ?? "",
      end: item.end.dateTime ?? item.end.date ?? "",
      location: item.location ?? null,
    };
  }

  /**
   * Edits an existing event's summary/time/location in place via a PATCH
   * (only the given fields are sent, so anything unset here — like
   * attendees — is left untouched by Google) — without this, the only
   * way to change anything about an event was delete-then-recreate,
   * which loses its id and drops attendees/description for no reason.
   */
  async updateEvent(
    eventId: string,
    changes: { summary?: string; start?: string; end?: string; location?: string | null }
  ): Promise<CalendarEvent> {
    const accessToken = await this.getValidAccessToken();

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

    const item = (await response.json()) as {
      id: string;
      summary?: string;
      location?: string;
      start: { dateTime?: string; date?: string };
      end: { dateTime?: string; date?: string };
    };

    return {
      id: item.id,
      summary: item.summary ?? "(no title)",
      start: item.start.dateTime ?? item.start.date ?? "",
      end: item.end.dateTime ?? item.end.date ?? "",
      location: item.location ?? null,
    };
  }

  /** Deletes an event from the user's primary calendar by its id. */
  async deleteEvent(eventId: string): Promise<void> {
    const accessToken = await this.getValidAccessToken();

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
