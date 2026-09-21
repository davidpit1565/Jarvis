// A small, dependency-free bounded-fetch helper shared by every JARVIS-side
// HTTP client that talks to an external API over raw `fetch()` (Gmail,
// Telegram, RSS — see each call site for why). Two things every one of
// those clients needs and none of them had:
//
//  1. An explicit timeout. Bun's/Node's default `fetch()` has no timeout at
//     all — a stuck connection to a flaky external API would otherwise hang
//     a tool call (and the turn waiting on it) indefinitely.
//  2. Retry-with-backoff on the errors that are actually worth retrying —
//     429 (rate limited) and 5xx (transient server-side failure) — so a
//     single blip doesn't surface as an immediate tool failure. This is the
//     same shape as `ClaudeBrain`'s reasoning for retrying 429/503/529
//     against Anthropic's API, generalized: `ClaudeBrain` itself doesn't
//     implement retry/backoff directly (it delegates to the Anthropic SDK's
//     own `maxRetries`), so there's no existing retry *implementation* to
//     import — only the "which statuses are worth retrying" judgment to
//     reuse. A real backoff loop is written once, here, instead of being
//     copy-pasted into GmailClient/RssNewsClient/TelegramGateway
//     separately.
//
// Deliberately NOT applied to Anthropic's server-side web_search/web_fetch
// tools (`JARVIS_WEB_SEARCH`/`JARVIS_WEB_FETCH`) — those run on Anthropic's
// own infrastructure behind the Messages API and are already
// timeout/retried by the Anthropic SDK client `ClaudeBrain` constructs;
// adding a second, redundant client-side timeout/retry layer around a call
// this process doesn't even make directly would do nothing useful.

export interface FetchWithRetryOptions {
  /** Aborts the request after this many ms. Default 10s — long enough for a slow real API, short enough not to hang a tool call. */
  timeoutMs?: number;
  /** Max attempts including the first. Default 3 (i.e. up to 2 retries). */
  maxAttempts?: number;
  /** Base delay for exponential backoff between retries, in ms. Default 300ms (300ms, 600ms, ...). */
  baseDelayMs?: number;
  /**
   * Whether a network-level failure (thrown by `fetch()` itself — a
   * connection reset, DNS failure, or the timeout above) is safe to
   * retry. Default true (the request never reached the server, so
   * retrying can't duplicate any effect it had) — set false for a
   * non-idempotent request (e.g. "send this email") where a network
   * failure leaves genuine ambiguity about whether the server already
   * received and processed it, and retrying could send it twice.
   */
  retryNetworkErrors?: boolean;
  /** Overrides which HTTP statuses are treated as retryable. Default: 429 and any 5xx (`isRetryableStatus`). */
  retryableStatuses?: (status: number) => boolean;
  /** Overridable for tests — real callers never pass this. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 300;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True for the specific failures a retry can actually help with — rate limiting and transient server errors, not a bad request or an auth failure. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * `fetch()` with a request timeout and retry-with-backoff on 429/5xx
 * responses or a network-level failure (e.g. connection reset). Returns
 * the first non-retryable response (2xx, 4xx other than 429) as-is —
 * callers keep doing their own `response.ok` handling exactly as before,
 * this only changes what got them the response.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  options: FetchWithRetryOptions = {}
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  const retryNetworkErrors = options.retryNetworkErrors ?? true;
  const isRetryable = options.retryableStatuses ?? isRetryableStatus;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timeoutId);

      if (isRetryable(response.status) && attempt < maxAttempts) {
        await sleep(baseDelayMs * 2 ** (attempt - 1));
        continue;
      }
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      lastError = error;
      if (!retryNetworkErrors || attempt >= maxAttempts) break;
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
