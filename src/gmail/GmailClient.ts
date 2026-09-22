import type { CalendarTokenStore } from "@/calendar/CalendarTokenStore";
import type { EmailSummary } from "@/types/gmail";
import { fetchWithRetry } from "@/core/net/fetchWithRetry";

const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_MESSAGES_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

// Same margin as GoogleCalendarClient, for the same reason: refresh a
// little before actual expiry so a request never straddles it.
const TOKEN_EXPIRY_SAFETY_MARGIN_MS = 60_000;

const MAX_RESULTS_CAP = 10;
const MAX_BODY_LENGTH = 4000;

const NO_ACCOUNT_LINKED_ERROR = "No Google account linked yet — visit GET /calendar/oauth/start to connect one.";

// Sending a message is not idempotent — retrying a request that actually
// reached Gmail before the response got lost could send the email twice.
// A 429 (rejected outright by Gmail's rate limiter before it did anything)
// is unambiguous and safe to retry; a network-level failure (where it's
// genuinely unclear whether Gmail received the request) is not, so this
// only retries the one status that's actually safe here — narrower than
// the default read-path retry policy (429 + any 5xx, network errors
// included) used by every other call in this class.
const SEND_RETRY_OPTIONS = { retryableStatuses: (status: number) => status === 429, retryNetworkErrors: false };

/**
 * Gmail access via raw fetch calls to the Gmail v1 REST API. Originally
 * read/search only; sendMessage/replyToMessage below were added on the
 * user's own explicit request (gmail.send scope, see GoogleCalendarClient's
 * GOOGLE_SCOPES) — still no delete or arbitrary mailbox-modify capability,
 * so the boundary is now "read + send, never delete/modify" rather than
 * fully read-only.
 *
 * Shares its OAuth tokens with GoogleCalendarClient (same CalendarTokenStore)
 * rather than requiring a second, separate account link per address.
 *
 * Operates over EVERY account CalendarTokenStore has linked: search/count
 * aggregate across all linked accounts by default (each EmailSummary
 * tagged with which account it came from), so the caller never has to say
 * which mailbox they mean. A send/reply always targets exactly one
 * account — the explicit `account` argument if given, else whichever
 * account was linked first (see `primaryAccount()`); reply additionally
 * resolves which account an existing message id belongs to when the
 * caller doesn't already know.
 */
export class GmailClient {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly tokenStore: CalendarTokenStore
  ) {}

  /** Every linked account's email, oldest-linked (primary) first. */
  linkedAccounts(): string[] {
    return this.tokenStore.getAll().map((a) => a.email);
  }

  /** The account a send/reply defaults to when none is specified — whichever was linked first — or null if nothing is linked. */
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

  /** Resolves which account a send (or an id-less read) should use: the explicit account if given (must actually be linked), else the primary (first-linked) account. */
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
   * Resolves which linked account an EXISTING message by id belongs to,
   * for reply when the caller doesn't already know. With a single linked
   * account this is free. With more than one, it probes each account's
   * metadata fetch in link order and uses the first that finds the
   * message; throws a combined "not found anywhere" error if none do.
   */
  private async resolveAccountForMessage(messageId: string, explicit?: string): Promise<string> {
    if (explicit) return this.resolveAccount(explicit);

    const accounts = this.tokenStore.getAll();
    if (accounts.length === 0) throw new Error(NO_ACCOUNT_LINKED_ERROR);
    if (accounts.length === 1) return accounts[0]!.email;

    const triedEmails: string[] = [];
    for (const account of accounts) {
      triedEmails.push(account.email);
      try {
        const accessToken = await this.getValidAccessToken(account.email);
        await this.fetchMessageMetadata(accessToken, messageId, ["Subject"]);
        return account.email;
      } catch {
        // Not in this account — try the next one.
      }
    }
    throw new Error(
      `Could not find message "${messageId}" in any linked account (tried: ${triedEmails.join(", ")}). ` +
        "Pass the account explicitly if you know which one it's in."
    );
  }

  private async fetchMessageMetadata(
    accessToken: string,
    id: string,
    headerNames: string[]
  ): Promise<{ id: string; threadId?: string; snippet?: string; payload?: { headers?: Array<{ name: string; value: string }> } }> {
    const url = new URL(`${GMAIL_MESSAGES_URL}/${encodeURIComponent(id)}`);
    url.searchParams.set("format", "metadata");
    for (const name of headerNames) url.searchParams.append("metadataHeaders", name);

    const response = await fetchWithRetry(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      throw new Error(`Gmail message fetch failed (${response.status}): ${await response.text().catch(() => "")}`);
    }

    return (await response.json()) as {
      id: string;
      threadId?: string;
      snippet?: string;
      payload?: { headers?: Array<{ name: string; value: string }> };
    };
  }

  private async getMessageSummary(accessToken: string, id: string, account: string): Promise<EmailSummary> {
    const data = await this.fetchMessageMetadata(accessToken, id, ["Subject", "From", "Date"]);

    const header = (name: string) =>
      data.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

    return {
      id: data.id,
      subject: header("Subject") || "(no subject)",
      from: header("From"),
      date: header("Date"),
      snippet: data.snippet ?? "",
      account,
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

  /** The full plain-text body of one message, given its id (from a search result). Searches every linked account for it unless `account` is given. */
  async getMessageBody(id: string, account?: string): Promise<{ subject: string; from: string; date: string; body: string; account: string }> {
    const resolvedAccount = await this.resolveAccountForMessage(id, account);
    const accessToken = await this.getValidAccessToken(resolvedAccount);

    const url = new URL(`${GMAIL_MESSAGES_URL}/${encodeURIComponent(id)}`);
    url.searchParams.set("format", "full");

    const response = await fetchWithRetry(url.toString(), {
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

    const rawBody = data.payload ? this.extractPlainTextBody(data.payload) : "";
    const body =
      rawBody.length > MAX_BODY_LENGTH
        ? `${rawBody.slice(0, MAX_BODY_LENGTH)}\n\n[... truncated, ${rawBody.length - MAX_BODY_LENGTH} more characters]`
        : rawBody;

    return {
      subject: header("Subject") || "(no subject)",
      from: header("From"),
      date: header("Date"),
      body,
      account: resolvedAccount,
    };
  }

  private async searchMessagesFor(email: string, query: string, maxResults: number): Promise<EmailSummary[]> {
    const accessToken = await this.getValidAccessToken(email);

    const url = new URL(GMAIL_MESSAGES_URL);
    url.searchParams.set("q", query);
    url.searchParams.set("maxResults", String(maxResults));

    const response = await fetchWithRetry(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      throw new Error(`Gmail search failed (${response.status}): ${await response.text().catch(() => "")}`);
    }

    const data = (await response.json()) as { messages?: Array<{ id: string }> };
    const messages = data.messages ?? [];

    const summaries: EmailSummary[] = [];
    for (const message of messages) {
      summaries.push(await this.getMessageSummary(accessToken, message.id, email));
    }
    return summaries;
  }

  /**
   * Searches the mailbox using Gmail's own search syntax (e.g. "from:x
   * is:unread") — across every linked account (each result tagged with
   * which account it came from), or just `account` if given, merged
   * newest-first and capped to `maxResults` after merging.
   */
  async searchMessages(query: string, maxResults: number = 5, account?: string): Promise<EmailSummary[]> {
    const cappedMaxResults = Math.min(maxResults, MAX_RESULTS_CAP);

    if (account) {
      this.resolveAccount(account);
      return this.searchMessagesFor(account, query, cappedMaxResults);
    }

    const accounts = this.tokenStore.getAll();
    if (accounts.length === 0) throw new Error(NO_ACCOUNT_LINKED_ERROR);

    const perAccountResults = await Promise.all(accounts.map((a) => this.searchMessagesFor(a.email, query, cappedMaxResults)));
    const merged = perAccountResults.flat();
    merged.sort((a, b) => (Date.parse(b.date || "") || 0) - (Date.parse(a.date || "") || 0));
    return merged.slice(0, cappedMaxResults);
  }

  private async getMessageCountFor(email: string, query: string): Promise<number> {
    const accessToken = await this.getValidAccessToken(email);

    const url = new URL(GMAIL_MESSAGES_URL);
    url.searchParams.set("q", query);
    url.searchParams.set("maxResults", "1");

    const response = await fetchWithRetry(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      throw new Error(`Gmail search failed (${response.status}): ${await response.text().catch(() => "")}`);
    }

    const data = (await response.json()) as { resultSizeEstimate?: number };
    return data.resultSizeEstimate ?? 0;
  }

  /**
   * Just the count of messages matching a query, via Gmail's own
   * `resultSizeEstimate` — no per-message summary fetch, unlike
   * searchMessages(). Summed across every linked account by default (or
   * just `account`, if given) — meaningfully cheaper than
   * searchMessages("is:unread") across every mailbox, which only ever
   * needs a total number, not each message's subject/sender/date.
   */
  async getMessageCount(query: string, account?: string): Promise<number> {
    if (account) {
      this.resolveAccount(account);
      return this.getMessageCountFor(account, query);
    }

    const accounts = this.tokenStore.getAll();
    if (accounts.length === 0) throw new Error(NO_ACCOUNT_LINKED_ERROR);

    const counts = await Promise.all(accounts.map((a) => this.getMessageCountFor(a.email, query)));
    return counts.reduce((sum, n) => sum + n, 0);
  }

  /**
   * Strips CR/LF from a value that goes into a raw email header — without
   * this, a `to` or `subject` string containing a newline could inject
   * extra headers (e.g. a second `Bcc:` line) into the raw RFC 2822
   * message this builds. Gmail's own API almost certainly rejects a raw
   * message with malformed headers, but this is the actual boundary, not
   * "Gmail probably catches it."
   */
  private sanitizeHeaderValue(value: string): string {
    return value.replace(/[\r\n]+/g, " ").trim();
  }

  /** Base64url — required for Gmail's `raw` message field, distinct from Buffer's plain base64. */
  private toBase64Url(input: string): string {
    return Buffer.from(input, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  private buildRawMessage(params: {
    to: string;
    subject: string;
    body: string;
    inReplyTo?: string;
    references?: string;
  }): string {
    const to = this.sanitizeHeaderValue(params.to);
    const subject = this.sanitizeHeaderValue(params.subject);
    const headers = [`To: ${to}`, `Subject: ${subject}`, "MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"'];
    if (params.inReplyTo) headers.push(`In-Reply-To: ${this.sanitizeHeaderValue(params.inReplyTo)}`);
    if (params.references) headers.push(`References: ${this.sanitizeHeaderValue(params.references)}`);
    return `${headers.join("\r\n")}\r\n\r\n${params.body}`;
  }

  /** Sends a brand-new email (not a reply to anything) from one account — `account` if given, else whichever account was linked first. Returns the new message's Gmail id and which account sent it. */
  async sendMessage(to: string, subject: string, body: string, account?: string): Promise<{ id: string; account: string }> {
    const resolvedAccount = this.resolveAccount(account);
    const accessToken = await this.getValidAccessToken(resolvedAccount);
    const raw = this.toBase64Url(this.buildRawMessage({ to, subject, body }));

    const response = await fetchWithRetry(
      GMAIL_SEND_URL,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ raw }),
      },
      SEND_RETRY_OPTIONS
    );

    if (!response.ok) {
      throw new Error(`Gmail send failed (${response.status}): ${await response.text().catch(() => "")}`);
    }

    const data = (await response.json()) as { id: string };
    return { id: data.id, account: resolvedAccount };
  }

  /**
   * Replies within an existing thread: fetches the original message's
   * `From`/`Subject`/`Message-ID`/`References` headers and its `threadId`
   * first, so the reply lands in the same Gmail thread and email clients
   * recognize it as a reply (`In-Reply-To`/`References` set correctly),
   * rather than sending a disconnected new message that merely mentions
   * the original. Resolves which account the original message belongs to
   * the same way getMessageBody() does, unless `account` is given
   * explicitly.
   */
  async replyToMessage(messageId: string, body: string, account?: string): Promise<{ id: string; account: string }> {
    const resolvedAccount = await this.resolveAccountForMessage(messageId, account);
    const accessToken = await this.getValidAccessToken(resolvedAccount);

    const original = await this.fetchMessageMetadata(accessToken, messageId, ["Subject", "From", "Message-ID", "References"]);
    const header = (name: string) =>
      original.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

    const originalFrom = header("From");
    if (!originalFrom) {
      throw new Error(`Could not determine the original message's sender (message ${messageId}) — cannot reply.`);
    }
    const originalSubject = header("Subject") || "(no subject)";
    const replySubject = /^re:/i.test(originalSubject) ? originalSubject : `Re: ${originalSubject}`;
    const originalMessageIdHeader = header("Message-ID");
    const references = [header("References"), originalMessageIdHeader].filter(Boolean).join(" ").trim();

    const raw = this.toBase64Url(
      this.buildRawMessage({
        to: originalFrom,
        subject: replySubject,
        body,
        inReplyTo: originalMessageIdHeader || undefined,
        references: references || undefined,
      })
    );

    const response = await fetchWithRetry(
      GMAIL_SEND_URL,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ raw, threadId: original.threadId }),
      },
      SEND_RETRY_OPTIONS
    );

    if (!response.ok) {
      throw new Error(`Gmail reply failed (${response.status}): ${await response.text().catch(() => "")}`);
    }

    const data = (await response.json()) as { id: string };
    return { id: data.id, account: resolvedAccount };
  }
}
