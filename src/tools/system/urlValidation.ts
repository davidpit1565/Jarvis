export interface UrlValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validates a Claude-supplied URL before it's ever sent to a device to be
 * opened. Only `http`/`https` are allowed — this is the one thing standing
 * between "open this URL" and a device agent handing an arbitrary scheme
 * (`file://`, `javascript:`, a custom app-launching URL scheme) straight to
 * the OS. Deliberately conservative: this tool's entire job is opening a
 * web page in the default browser, nothing else.
 */
export function validateUrl(input: string): UrlValidationResult {
  if (typeof input !== "string" || input.trim() === "") {
    return { valid: false, reason: "URL must be a non-empty string" };
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { valid: false, reason: "Not a valid absolute URL" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { valid: false, reason: `Scheme "${url.protocol}" is not allowed — only http/https` };
  }

  return { valid: true };
}
