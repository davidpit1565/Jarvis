import { constantTimeEqual } from "@/security/constantTimeEqual";

/** One reply heard during a proactive (JARVIS-initiated) announcement's reply window. */
export interface SpeakerAuthRequest {
  deviceId: string;
  /** What was actually heard, as transcribed on-device. */
  text: string;
}

export interface SpeakerAuthResult {
  authenticated: boolean;
  /** Human-readable reason, for logging/activity — never shown as a security boundary on its own. */
  reason: string;
}

/**
 * Decides whether a spoken reply to a proactive, JARVIS-initiated
 * "wake up and speak" event (a device-announced reminder — see
 * ProactiveAnnouncer) should be treated as really coming from the owner,
 * as opposed to whoever happens to be standing nearby.
 *
 * This is deliberately a separate, narrow interface from
 * `ConfirmationService`: that one answers "is this ACTION approved" for a
 * CONFIRM/DANGEROUS tool call the assistant is *already* having a
 * conversation with someone about; this one answers "is this SPEAKER who I
 * think it is" for a conversation JARVIS itself started unprompted — a
 * genuinely different question. Conflating them would mean every future
 * change to one risks silently changing the other.
 *
 * CLAUDE.md wishlist #19 names three mechanisms of growing sophistication
 * the owner wants to grow into: (a) a shared code/passphrase (implemented
 * here as `PassphraseSpeakerAuthenticator` — this pass), (b) voice
 * recognition (a specific speaker's voice, not just the right words), and
 * (c) a private, evolving "code language" between him and JARVIS. Keeping
 * "how do we authenticate a proactive reply" behind this one named
 * interface, rather than scattered inline string-comparison logic, is what
 * lets (b)/(c) be swapped in — or layered: try voice biometrics first,
 * fall back to passphrase — later without rearchitecting every caller.
 * Building (b)/(c) themselves is explicitly out of scope for this pass
 * (see the PR description).
 */
export interface SpeakerAuthenticator {
  authenticate(request: SpeakerAuthRequest): SpeakerAuthResult;
}

/**
 * Normalizes spoken text for passphrase comparison: trims, lowercases,
 * strips punctuation, and collapses whitespace. Speech-to-text output
 * rarely matches a typed phrase byte-for-byte (capitalization, a trailing
 * period, double spaces) — without this, a perfectly correct spoken
 * passphrase would routinely fail to match.
 */
function normalizeSpokenText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ");
}

/**
 * Today's implementation of SpeakerAuthenticator: a shared passphrase only
 * the owner is expected to know, set via SET_CONFIRMATION_PASSPHRASE (or
 * `JARVIS_CONFIRMATION_PASSPHRASE` as an initial seed — see
 * ConfirmationPassphraseStore). `getPassphrase` is a thunk rather than a
 * fixed string so this always checks against whatever is currently stored,
 * including a passphrase changed after this authenticator was constructed.
 *
 * Deliberately NOT voice/speaker biometrics — matching the exact words is
 * all this checks; anyone who knows (or overhears) the passphrase passes.
 * That's the explicitly scoped-down starting point from CLAUDE.md #19,
 * not a design oversight.
 */
export class PassphraseSpeakerAuthenticator implements SpeakerAuthenticator {
  constructor(private readonly getPassphrase: () => string | null) {}

  authenticate({ text }: SpeakerAuthRequest): SpeakerAuthResult {
    const passphrase = this.getPassphrase();
    if (!passphrase) {
      return { authenticated: false, reason: "No confirmation passphrase is configured" };
    }
    // Constant-time: a naive `===` here would short-circuit on the first
    // differing character, letting an attacker who can measure response
    // timing (e.g. repeatedly trying spoken/replayed guesses against a
    // paired device) narrow down the passphrase character-by-character
    // rather than needing the whole thing right in one guess.
    if (constantTimeEqual(normalizeSpokenText(text), normalizeSpokenText(passphrase))) {
      return { authenticated: true, reason: "Passphrase matched" };
    }
    return { authenticated: false, reason: "Passphrase did not match" };
  }
}
