import { randomBytes, randomInt, createHash, timingSafeEqual } from "node:crypto";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_PAIRING_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const PAIRING_CODE_DIGITS = 6;

export interface PendingPairing {
  deviceId: string;
  code: string;
  createdAt: number;
  expiresAt: number;
}

interface StoredCredential {
  deviceId: string;
  /** SHA-256 hex digest of the credential secret. Never the plaintext secret. */
  secretHash: string;
  createdAt: number;
}

export interface RequestPairingResult {
  code: string;
  expiresAt: number;
}

export interface ApprovePairingResult {
  /**
   * The plaintext long-lived credential, returned exactly once. The Agent
   * is expected to store this in the macOS Keychain; Core only ever keeps
   * its hash from this point on.
   */
  secret: string;
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function hashesEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "hex");
  const bufferB = Buffer.from(b, "hex");
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/**
 * Core-side pairing/authentication for device agents. First connection
 * requires an explicit human-approved pairing code; approval mints a
 * long-lived credential whose hash (never the plaintext) Core retains.
 *
 * Pending pairing codes stay in-memory only — they're short-lived (a few
 * minutes) and a device mid-pairing across a restart just requests a new
 * one, no real loss. Long-lived credentials are optionally persisted to
 * SQLite (pass a dbPath): without this, EVERY server restart would forget
 * every approved device's credential, forcing a full re-pair (a new
 * pairing code, a human approving it again) even though nothing about the
 * device actually changed — a real reliability gap for anything running
 * on a host that restarts/redeploys (Fly.io, a crash, a plain reboot).
 */
export class PairingService {
  private pending: Map<string, PendingPairing> = new Map();
  private credentials: Map<string, StoredCredential> = new Map();
  private db: Database | null = null;

  constructor(
    private readonly ttlMs: number = DEFAULT_PAIRING_CODE_TTL_MS,
    private readonly now: () => number = Date.now,
    dbPath?: string
  ) {
    if (!dbPath || dbPath === ":memory:") return;

    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS device_credentials (
        device_id TEXT PRIMARY KEY,
        secret_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);

    const rows = this.db.query(`SELECT device_id, secret_hash, created_at FROM device_credentials`).all() as Array<{
      device_id: string;
      secret_hash: string;
      created_at: number;
    }>;
    for (const row of rows) {
      this.credentials.set(row.device_id, { deviceId: row.device_id, secretHash: row.secret_hash, createdAt: row.created_at });
    }
  }

  /** Starts (or restarts) a pairing attempt for a device, returning a human-facing code. */
  requestPairing(deviceId: string): RequestPairingResult {
    const code = String(randomInt(0, 10 ** PAIRING_CODE_DIGITS)).padStart(PAIRING_CODE_DIGITS, "0");
    const createdAt = this.now();
    const expiresAt = createdAt + this.ttlMs;

    this.pending.set(deviceId, { deviceId, code, createdAt, expiresAt });
    return { code, expiresAt };
  }

  /**
   * A human confirms the pairing code out-of-band and approves it. Mints a
   * new long-lived credential and returns its plaintext exactly once.
   */
  approvePairing(deviceId: string, code: string): ApprovePairingResult {
    const pending = this.pending.get(deviceId);

    if (!pending) {
      throw new Error(`No pending pairing request for device: ${deviceId}`);
    }

    if (this.now() > pending.expiresAt) {
      this.pending.delete(deviceId);
      throw new Error(`Pairing code for device "${deviceId}" has expired`);
    }

    if (!constantTimeStringsEqual(pending.code, code)) {
      throw new Error("Pairing code does not match");
    }

    this.pending.delete(deviceId);

    const secret = randomBytes(32).toString("hex");
    const secretHash = hashSecret(secret);
    const createdAt = this.now();
    this.credentials.set(deviceId, { deviceId, secretHash, createdAt });

    if (this.db) {
      this.db
        .query(`INSERT OR REPLACE INTO device_credentials (device_id, secret_hash, created_at) VALUES (?, ?, ?)`)
        .run(deviceId, secretHash, createdAt);
    }

    return { secret };
  }

  /** Verifies a credential presented by a device on reconnect. */
  verifyCredential(deviceId: string, secret: string): boolean {
    const stored = this.credentials.get(deviceId);
    if (!stored) return false;
    return hashesEqual(stored.secretHash, hashSecret(secret));
  }

  hasCredential(deviceId: string): boolean {
    return this.credentials.has(deviceId);
  }

  getPendingPairing(deviceId: string): PendingPairing | undefined {
    const pending = this.pending.get(deviceId);
    if (!pending) return undefined;
    if (this.now() > pending.expiresAt) {
      this.pending.delete(deviceId);
      return undefined;
    }
    return pending;
  }

  /** Revokes a device's credential (lost/decommissioned device). It must re-pair from scratch. */
  revoke(deviceId: string): void {
    this.credentials.delete(deviceId);
    this.pending.delete(deviceId);
    this.db?.query(`DELETE FROM device_credentials WHERE device_id = ?`).run(deviceId);
  }

  close(): void {
    this.db?.close();
  }
}

function constantTimeStringsEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
