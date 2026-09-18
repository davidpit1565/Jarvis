import type { CalendarTokenStore } from "@/calendar/CalendarTokenStore";
import type { EmailSummary } from "@/types/gmail";

const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_MESSAGES_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages";

// Same margin as GoogleCalendarClient, for the same reason: refresh a
// little before actual expiry so a request never straddles it.
const TOKEN_EXPIRY_SAFETY_MARGIN_MS = 60_000;

const MAX_RESULTS_CAP = 10;

/**
 * Gmail access via raw fetch calls to the Gmail v1 REST API — read/search
 * only (the OAuth scope requested is gmail.readonly; there is no send,
 * delete, or modify capability here at all, by design, matching the
 * "scoped, not blanket mailbox access" boundary this feature was built to).
 *
 * Shares its OAuth tokens with GoogleCalendarClient (same CalendarTokenStore,
 * same Google account, one consent screen covering both scopes) rather than
 * requiring a second, separate account link for the same account.
 *
 * REQUIRES REAL VALIDATION: never exercised against a real Gmail account.
 */
export class GmailClient {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly tokenStore: CalendarTokenStore
  ) {}

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

  private async getMessageSummary(accessToken: string, id: string): Promise<EmailSummary> {
    const url = new URL(`${GMAIL_MESSAGES_URL}/${encodeURIComponent(id)}`);
    url.searchParams.set("format", "metadata");
    url.searchParams.append("metadataHeaders", "Subject");
    url.searchParams.append("metadataHeaders", "From");
    url.searchParams.append("metadataHeaders", "Date");

    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      throw new Error(`Gmail message fetch failed (${response.status}): ${await response.text().catch(() => "")}`);
    }

    const data = (await response.json()) as {
      id: string;
      snippet?: string;
      payload?: { headers?: Array<{ name: string; value: string }> };
    };

    const header = (name: string) =>
      data.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

    return {
      id: data.id,
      subject: header("Subject") || "(no subject)",
      from: header("From"),
      date: header("Date"),
      snippet: data.snippet ?? "",
    };
  }

  /**
   * Extracts the best plain-text body out of a Gmail message payload,
   * walking multipart parts depth-first and preferring `text/plain` over
   * `text/html` (Gmail sends both for most real mail) — falls back to the
   * top-level body if the message isn't multipart at all.
   */
  private extractPlainTextBody(payload: {
    mimeType?: string;
    body?: { data?: string };
    parts?: Array<{ mimeType?: string; body?: { data?: string }; parts?: unknown[] }>;
  }): string {
    const decode = (data: string) => Buffer.from(data, "base64url").toString("utf8");

    if (payload.mimeType === "text/plain" && payload.body?.data) {
      return decode(payload.body.data);
    }

    if (payload.parts) {
      const plainPart = payload.parts.find((p) => p.mimeType === "text/plain" && p.body?.data);
      if (plainPart?.body?.data) return decode(plainPart.body.data);

      for (const part of payload.parts) {
        const nested = this.extractPlainTextBody(part as typeof payload);
        if (nested) return nested;
      }
    }

    if (payload.body?.data) return decode(payload.body.data);
    return "";
  }

  /** The full plain-text body of one message, given its id (from a search result). */
  async getMessageBody(id: string): Promise<{ subject: string; from: string; date: string; body: string }> {
    const accessToken = await this.getValidAccessToken();

    const url = new URL(`${GMAIL_MESSAGES_URL}/${encodeURIComponent(id)}`);
    url.searchParams.set("format", "full");

    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      throw new Error(`Gmail message fetch failed (${response.status}): ${await response.text().catch(() => "")}`);
    }

    const data = (await response.json()) as {
      payload?: {
        mimeType?: string;
        body?: { data?: string };
        headers?: Array<{ name: string; value: string }>;
        parts?: Array<{ mimeType?: string; body?: { data?: string }; parts?: unknown[] }>;
      };
    };

    const header = (name: string) =>
      data.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

    return {
      subject: header("Subject") || "(no subject)",
      from: header("From"),
      date: header("Date"),
      body: data.payload ? this.extractPlainTextBody(data.payload) : "",
    };
  }

  /** Searches the linked account's mailbox using Gmail's own search syntax (e.g. "from:x is:unread"). */
  async searchMessages(query: string, maxResults: number = 5): Promise<EmailSummary[]> {
    const accessToken = await this.getValidAccessToken();
    const cappedMaxResults = Math.min(maxResults, MAX_RESULTS_CAP);

    const url = new URL(GMAIL_MESSAGES_URL);
    url.searchParams.set("q", query);
    url.searchParams.set("maxResults", String(cappedMaxResults));

    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      throw new Error(`Gmail search failed (${response.status}): ${await response.text().catch(() => "")}`);
    }

    const data = (await response.json()) as { messages?: Array<{ id: string }> };
    const messages = data.messages ?? [];

    const summaries: EmailSummary[] = [];
    for (const message of messages) {
      summaries.push(await this.getMessageSummary(accessToken, message.id));
    }
    return summaries;
  }
}
