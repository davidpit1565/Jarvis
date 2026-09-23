import { fetchWithRetry } from "@/core/net/fetchWithRetry";
import { apiError } from "@/core/net/apiError";
import type { AgentMailMessage, AgentMailMessageSummary, AgentMailSendResult } from "@/types/agentmail";

const AGENTMAIL_BASE_URL = "https://api.agentmail.to";

// Gmail-style: unbounded "give me everything" reads are how a single tool
// call turns into an unbounded response — see MemoryStore.search's own
// DEFAULT_QUERY_LIMIT fix for the same reasoning applied elsewhere in this
// codebase.
const MAX_RESULTS_CAP = 20;
const DEFAULT_MAX_RESULTS = 10;
const MAX_BODY_LENGTH = 4000;

// Sending is not idempotent for the same reason GmailClient's SEND_RETRY_OPTIONS
// exists: a network-level failure leaves genuine ambiguity about whether
// AgentMail already received and sent the message, so only the
// unambiguous "rejected outright by their rate limiter" status is safe to
// retry automatically.
const SEND_RETRY_OPTIONS = { retryableStatuses: (status: number) => status === 429, retryNetworkErrors: false };

/**
 * AgentMail REST API client (https://docs.agentmail.to) — gives JARVIS its
 * own independent email identity (e.g. jarvis@agentmail.to), completely
 * separate from the user's personal Gmail account handled by GmailClient.
 * This client never touches GmailClient/GoogleCalendarClient/CalendarTokenStore
 * at all; it's a wholly separate integration with its own API key and its
 * own single configured inbox id.
 *
 * Endpoint shapes below (base URL, auth header, paths, field names) were
 * verified directly against AgentMail's own published API reference during
 * this feature's implementation:
 *   - POST /v0/inboxes/{inbox_id}/messages/send  (docs.agentmail.to/api-reference/inboxes/messages/send)
 *   - GET  /v0/inboxes/{inbox_id}/messages        (docs.agentmail.to/api-reference/inboxes/messages/list)
 *   - GET  /v0/inboxes/{inbox_id}/messages/{message_id} (docs.agentmail.to/api-reference/inboxes/messages/get)
 * Auth is a simple `Authorization: Bearer <api_key>` header — no OAuth
 * flow, no token refresh, unlike Gmail/Calendar/Spotify: AgentMail's API
 * key is a long-lived static credential the user generates once in their
 * AgentMail dashboard and pastes into config, so this client is
 * considerably simpler than GmailClient (no CalendarTokenStore-style
 * refresh dance needed).
 *
 * Same raw-`fetch` + fetchWithRetry style as every other JARVIS HTTP
 * client (GmailClient, GoogleCalendarClient, RssNewsClient) — no SDK
 * dependency.
 *
 * REQUIRES REAL VALIDATION: never exercised against a real AgentMail
 * account/inbox — the endpoint shapes above come from AgentMail's own
 * documentation, not from a live call this codebase has actually made.
 */
export class AgentMailClient {
  constructor(
    private readonly apiKey: string,
    private readonly inboxId: string
  ) {}

  private authHeaders(): Record<string, string> {
    // Never log this header or include it in any error message — the
    // caller-facing error text below only ever includes the HTTP status
    // and AgentMail's own response body, never request headers.
    return { Authorization: `Bearer ${this.apiKey}` };
  }

  /** Sends a real email from JARVIS's own AgentMail inbox. Returns the new message's id and thread id. */
  async sendMessage(to: string, subject: string, body: string): Promise<AgentMailSendResult> {
    const url = `${AGENTMAIL_BASE_URL}/v0/inboxes/${encodeURIComponent(this.inboxId)}/messages/send`;

    const response = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: { ...this.authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ to: [to], subject, text: body }),
      },
      SEND_RETRY_OPTIONS
    );

    if (!response.ok) {
      throw new Error(await this.describeFailure("AgentMail send", response));
    }

    const data = (await response.json()) as { message_id: string; thread_id: string };
    return { messageId: data.message_id, threadId: data.thread_id };
  }

  /**
   * Lists the most recent messages in JARVIS's own inbox, newest first.
   * Bounded the same way GmailClient.searchMessages/MemoryStore.search
   * are — a caller can never pull an unlimited number of messages in one
   * call, regardless of what maxResults it asks for.
   */
  async listMessages(maxResults: number = DEFAULT_MAX_RESULTS): Promise<AgentMailMessageSummary[]> {
    const cappedMaxResults = Math.min(Math.max(1, maxResults), MAX_RESULTS_CAP);

    const url = new URL(`${AGENTMAIL_BASE_URL}/v0/inboxes/${encodeURIComponent(this.inboxId)}/messages`);
    url.searchParams.set("limit", String(cappedMaxResults));

    const response = await fetchWithRetry(url.toString(), { headers: this.authHeaders() });

    if (!response.ok) {
      throw new Error(await this.describeFailure("AgentMail inbox list", response));
    }

    const data = (await response.json()) as {
      messages?: Array<{
        message_id: string;
        thread_id: string;
        from: string;
        to?: string[];
        subject?: string;
        preview?: string;
        timestamp: string;
      }>;
    };

    return (data.messages ?? []).map((message) => ({
      messageId: message.message_id,
      threadId: message.thread_id,
      from: message.from,
      to: message.to ?? [],
      subject: message.subject || "(no subject)",
      preview: message.preview ?? "",
      timestamp: message.timestamp,
    }));
  }

  /** Fetches one message's full plain-text body by id, given an id from a prior listMessages() call. */
  async getMessage(messageId: string): Promise<AgentMailMessage> {
    const url = `${AGENTMAIL_BASE_URL}/v0/inboxes/${encodeURIComponent(this.inboxId)}/messages/${encodeURIComponent(messageId)}`;

    const response = await fetchWithRetry(url, { headers: this.authHeaders() });

    if (!response.ok) {
      throw new Error(await this.describeFailure("AgentMail message fetch", response));
    }

    const data = (await response.json()) as {
      message_id: string;
      thread_id: string;
      from: string;
      to?: string[];
      subject?: string;
      preview?: string;
      timestamp: string;
      text?: string;
      html?: string;
    };

    const rawBody = data.text ?? "";
    const text =
      rawBody.length > MAX_BODY_LENGTH
        ? `${rawBody.slice(0, MAX_BODY_LENGTH)}\n\n[... truncated, ${rawBody.length - MAX_BODY_LENGTH} more characters]`
        : rawBody;

    return {
      messageId: data.message_id,
      threadId: data.thread_id,
      from: data.from,
      to: data.to ?? [],
      subject: data.subject || "(no subject)",
      preview: data.preview ?? "",
      timestamp: data.timestamp,
      text,
      html: data.html,
    };
  }

  /**
   * Builds a caller-facing error message from a non-2xx response —
   * centralized here since three methods need it. 401/403/429 get a
   * fixed, sanitized message; everything else routes through apiError()
   * (status code only — the raw body is logged server-side, never
   * returned) so AgentMail's own response body never reaches the
   * model/user via ToolResult.error.
   */
  private async describeFailure(label: string, response: Response): Promise<string> {
    if (response.status === 401 || response.status === 403) {
      return `${label} failed (${response.status}): AgentMail rejected the configured API key — check AGENTMAIL_API_KEY.`;
    }
    if (response.status === 429) {
      return `${label} failed (429): AgentMail rate limit hit — try again shortly.`;
    }
    // Every other status (400 validation errors, 404, 5xx, etc.) falls
    // through to here — routes through apiError() like every sibling HTTP
    // client (Gmail/Calendar/Spotify/OpenMeteo/Twilio) so AgentMail's raw
    // response body (which can include internal reason strings or echoed
    // request fragments) is logged server-side only, never surfaced to
    // the model/user via ToolResult.error.
    return (await apiError(label, response)).message;
  }
}
