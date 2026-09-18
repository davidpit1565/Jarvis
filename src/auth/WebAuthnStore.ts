import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { WebAuthnCredential } from "@simplewebauthn/server";

interface StoredRow {
  id: string;
  public_key: string;
  counter: number;
  transports: string | null;
}

/**
 * Persists WebAuthn (Face ID / Touch ID / passkey) credentials for the
 * single local JARVIS user. Small and SQLite-backed, matching MemoryStore's
 * pattern — separate database file so it stays independent of the
 * assistant's own memory records.
 */
export class WebAuthnStore {
  private db: Database;

  constructor(dbPath: string = ":memory:") {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS webauthn_credentials (
        id TEXT PRIMARY KEY,
        public_key TEXT NOT NULL,
        counter INTEGER NOT NULL,
        transports TEXT
      )
    `);
  }

  save(credential: WebAuthnCredential): void {
    this.db
      .query(`INSERT INTO webauthn_credentials (id, public_key, counter, transports) VALUES (?, ?, ?, ?)`)
      .run(
        credential.id,
        Buffer.from(credential.publicKey).toString("base64"),
        credential.counter,
        credential.transports ? JSON.stringify(credential.transports) : null
      );
  }

  get(id: string): WebAuthnCredential | null {
    const row = this.db.query(`SELECT * FROM webauthn_credentials WHERE id = ?`).get(id) as StoredRow | null;
    return row ? this.toCredential(row) : null;
  }

  list(): WebAuthnCredential[] {
    const rows = this.db.query(`SELECT * FROM webauthn_credentials`).all() as StoredRow[];
    return rows.map((row) => this.toCredential(row));
  }

  updateCounter(id: string, counter: number): void {
    this.db.query(`UPDATE webauthn_credentials SET counter = ? WHERE id = ?`).run(counter, id);
  }

  close(): void {
    this.db.close();
  }

  private toCredential(row: StoredRow): WebAuthnCredential {
    return {
      id: row.id,
      publicKey: new Uint8Array(Buffer.from(row.public_key, "base64")),
      counter: row.counter,
      transports: row.transports ? JSON.parse(row.transports) : undefined,
    };
  }
}
