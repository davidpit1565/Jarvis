import { randomBytes } from "node:crypto";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// Every login mints a new token and abandons whatever token the previous
// session was using — without a periodic sweep (same pattern as
// RateLimiter.maybeSweep), only a token that happens to get looked up again
// after expiring is ever removed, and a browser tab that's simply closed
// leaves its entry behind forever. On a long-running, no-scheduled-restarts
// process this grows by one entry per login indefinitely.
const SWEEP_INTERVAL_CREATES = 20;

/**
 * In-memory dashboard session tokens issued after a successful WebAuthn
 * login. Deliberately not persisted — a restart requiring a fresh Face ID
 * unlock is an acceptable, safer default than a long-lived session
 * surviving on disk. Matches DeviceRegistry/PermissionService's in-memory
 * pattern from Phase 2.
 */
export class SessionStore {
  private sessions: Map<string, number> = new Map();
  private createsSinceSweep = 0;

  constructor(private readonly ttlMs: number = SESSION_TTL_MS) {}

  create(): string {
    const token = randomBytes(32).toString("hex");
    this.sessions.set(token, Date.now() + this.ttlMs);
    this.maybeSweep();
    return token;
  }

  isValid(token: string | null | undefined): boolean {
    if (!token) return false;
    const expiresAt = this.sessions.get(token);
    if (!expiresAt) return false;
    if (expiresAt < Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  /** Explicitly invalidates one session (a logout) — a no-op if the token doesn't exist or was already removed. */
  revoke(token: string | null | undefined): void {
    if (!token) return;
    this.sessions.delete(token);
  }

  private maybeSweep(): void {
    this.createsSinceSweep += 1;
    if (this.createsSinceSweep < SWEEP_INTERVAL_CREATES) return;
    this.createsSinceSweep = 0;

    const now = Date.now();
    for (const [token, expiresAt] of this.sessions) {
      if (expiresAt < now) this.sessions.delete(token);
    }
  }
}
