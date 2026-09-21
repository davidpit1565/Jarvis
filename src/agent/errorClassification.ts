export type ErrorClass = "transient" | "permanent";

/**
 * The same transient-vs-permanent distinction ClaudeBrain/AIRouter already
 * make for provider-call retries (429 rate limit, 503/529 overloaded,
 * network hiccups) — reused here, not reimplemented from scratch, for tool
 * *step* failures inside an agent task. A transient failure is worth
 * retrying the same step for; a permanent one (bad input, permission
 * denied, a tool that doesn't exist) never gets better by retrying, so it
 * goes straight to a RECOVERING replan instead of burning retry budget.
 */
const TRANSIENT_PATTERNS: RegExp[] = [
  /\btime(d)?[\s-]?out\b/i,
  /\bnetwork\b/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /\brate limit(ed)?\b/i,
  /\b429\b/,
  /\b503\b/,
  /\b529\b/,
  /\boverloaded\b/i,
  /temporarily unavailable/i,
  /\bdisconnected\b/i,
  /connection (reset|closed|refused)/i,
];

/** Permission/authorization/confirmation failures are never worth retrying — only a human or a different plan can fix them. */
const PERMANENT_PATTERNS: RegExp[] = [
  /permission denied/i,
  /unknown tool/i,
  /invalid input/i,
  /declined to confirm/i,
  /no confirmation channel/i,
  /lockdown/i,
];

export function classifyError(message: string | undefined | null): ErrorClass {
  if (!message) return "permanent";
  if (PERMANENT_PATTERNS.some((pattern) => pattern.test(message))) return "permanent";
  if (TRANSIENT_PATTERNS.some((pattern) => pattern.test(message))) return "transient";
  return "permanent";
}
