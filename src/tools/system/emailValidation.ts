export interface EmailValidationResult {
  valid: boolean;
  reason?: string;
}

// Deliberately simple — this only needs to reject obviously-wrong input
// before it reaches a mailto: URL (a stray newline that could inject
// extra mailto: fields, an empty string), not fully validate RFC 5322.
const SIMPLE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEmailAddress(input: string): EmailValidationResult {
  if (typeof input !== "string" || input.trim() === "") {
    return { valid: false, reason: "Recipient must be a non-empty string" };
  }
  if (/[\r\n]/.test(input)) {
    return { valid: false, reason: "Recipient must not contain line breaks" };
  }
  if (!SIMPLE_EMAIL.test(input)) {
    return { valid: false, reason: "Recipient does not look like a valid email address" };
  }
  return { valid: true };
}
