export interface AppNameValidationResult {
  valid: boolean;
  reason?: string;
}

// Letters, digits, spaces, and the handful of punctuation marks that show
// up in real macOS app names ("Numbers", "1Password 7", "Bear - Notes").
// No slashes, backticks, dollar signs, semicolons, or other shell/path
// metacharacters — this name only ever reaches NSWorkspace's app-lookup
// API on the device side, never a shell, but validating it here too means
// a compromised or confused caller can't smuggle anything path-like
// through Core's own tool-call boundary in the first place.
const SAFE_APP_NAME = /^[\p{L}\p{N} .,'&_-]{1,80}$/u;

export function validateAppName(input: string): AppNameValidationResult {
  if (typeof input !== "string" || input.trim() === "") {
    return { valid: false, reason: "Application name must be a non-empty string" };
  }
  if (!SAFE_APP_NAME.test(input)) {
    return { valid: false, reason: "Application name contains characters that aren't valid in a macOS app name" };
  }
  return { valid: true };
}
