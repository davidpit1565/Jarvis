import { randomBytes } from "node:crypto";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

/**
 * In-memory dashboard session tokens issued after a successful WebAuthn
 * login. Deliberately not persisted — a restart requiring a fresh Face ID
 * unlock is an acceptable, safer default than a long-lived session
 * surviving on disk. Matches DeviceRegistry/PermissionService's in-memory
 * pattern from Phase 2.
 */
export class SessionStore {
  private sessions: Map<string, number> = new Map();

  constructor(private readonly ttlMs: number = SESSION_TTL_MS) {}

  create(): string {
    const token = randomBytes(32).toString("hex");
    this.sessions.set(token, Date.now() + this.ttlMs);
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
}
