import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time string comparison for security-sensitive equality checks
 * (a passphrase, a token, a webhook secret) — never a plain `===`, which
 * short-circuits on the first differing byte and so leaks, via response
 * timing, how many leading characters of a guess were correct. Mirrors the
 * same pattern `JarvisWebSocketServer.ts`'s own private `constantTimeEqual`
 * already uses for admin-token/webhook-secret checks; this is a shared,
 * importable copy for callers outside that file (e.g.
 * `PassphraseSpeakerAuthenticator`) that need the same property.
 *
 * The length check before `timingSafeEqual` (which throws on mismatched
 * buffer lengths rather than comparing them) does itself leak length via
 * timing — an accepted, standard tradeoff: length alone is far less
 * exploitable than leaking which prefix is correct, and `timingSafeEqual`
 * has no mismatched-length mode to fall back to.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
