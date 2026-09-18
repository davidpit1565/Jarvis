import { describe, test, expect } from "bun:test";
import { PairingService } from "@/devices/pairing/PairingService";

describe("PairingService", () => {
  test("requestPairing produces a 6-digit code with an expiration in the future", () => {
    const service = new PairingService();
    const { code, expiresAt } = service.requestPairing("imac-1");

    expect(code).toMatch(/^\d{6}$/);
    expect(expiresAt).toBeGreaterThan(Date.now());
  });

  test("approvePairing with the correct code mints a credential", () => {
    const service = new PairingService();
    const { code } = service.requestPairing("imac-1");

    const { secret } = service.approvePairing("imac-1", code);

    expect(typeof secret).toBe("string");
    expect(secret.length).toBeGreaterThan(0);
    expect(service.hasCredential("imac-1")).toBe(true);
  });

  test("verifyCredential succeeds with the exact secret returned by approvePairing", () => {
    const service = new PairingService();
    const { code } = service.requestPairing("imac-1");
    const { secret } = service.approvePairing("imac-1", code);

    expect(service.verifyCredential("imac-1", secret)).toBe(true);
  });

  test("verifyCredential fails with a wrong secret", () => {
    const service = new PairingService();
    const { code } = service.requestPairing("imac-1");
    service.approvePairing("imac-1", code);

    expect(service.verifyCredential("imac-1", "wrong-secret")).toBe(false);
  });

  test("verifyCredential fails for a device with no stored credential", () => {
    const service = new PairingService();
    expect(service.verifyCredential("never-paired", "anything")).toBe(false);
  });

  test("approvePairing rejects an incorrect code", () => {
    const service = new PairingService();
    service.requestPairing("imac-1");

    expect(() => service.approvePairing("imac-1", "000000")).toThrow(/does not match/);
  });

  test("approvePairing rejects when there is no pending request", () => {
    const service = new PairingService();
    expect(() => service.approvePairing("imac-1", "123456")).toThrow(/No pending pairing/);
  });

  test("a pairing code expires after its TTL", () => {
    let now = 1_000_000;
    const service = new PairingService(1000, () => now);
    const { code } = service.requestPairing("imac-1");

    now += 1001; // past the 1000ms TTL

    expect(() => service.approvePairing("imac-1", code)).toThrow(/expired/);
  });

  test("getPendingPairing returns undefined once expired", () => {
    let now = 1_000_000;
    const service = new PairingService(1000, () => now);
    service.requestPairing("imac-1");

    now += 1001;

    expect(service.getPendingPairing("imac-1")).toBeUndefined();
  });

  test("revoke removes a credential, forcing re-pairing", () => {
    const service = new PairingService();
    const { code } = service.requestPairing("imac-1");
    const { secret } = service.approvePairing("imac-1", code);

    service.revoke("imac-1");

    expect(service.hasCredential("imac-1")).toBe(false);
    expect(service.verifyCredential("imac-1", secret)).toBe(false);
  });

  test("revoke also clears any pending (not yet approved) pairing", () => {
    const service = new PairingService();
    service.requestPairing("imac-1");

    service.revoke("imac-1");

    expect(service.getPendingPairing("imac-1")).toBeUndefined();
  });

  test("re-requesting pairing produces a usable, current code", () => {
    const service = new PairingService();
    service.requestPairing("imac-1");
    const second = service.requestPairing("imac-1");

    const { secret } = service.approvePairing("imac-1", second.code);
    expect(secret.length).toBeGreaterThan(0);
  });
});

describe("PairingService persistence", () => {
  test("an approved credential survives across instances backed by the same SQLite file", () => {
    const dbPath = `/tmp/jarvis-pairing-test-${crypto.randomUUID()}.sqlite`;

    const first = new PairingService(undefined, undefined, dbPath);
    first.requestPairing("imac-1");
    const pending = first.getPendingPairing("imac-1")!;
    const { secret } = first.approvePairing("imac-1", pending.code);
    first.close();

    const second = new PairingService(undefined, undefined, dbPath);
    expect(second.verifyCredential("imac-1", secret)).toBe(true);
    expect(second.hasCredential("imac-1")).toBe(true);
    second.close();
  });

  test("revoking a credential removes it from the backing store too", () => {
    const dbPath = `/tmp/jarvis-pairing-test-${crypto.randomUUID()}.sqlite`;

    const first = new PairingService(undefined, undefined, dbPath);
    first.requestPairing("imac-1");
    const pending = first.getPendingPairing("imac-1")!;
    first.approvePairing("imac-1", pending.code);
    first.revoke("imac-1");
    first.close();

    const second = new PairingService(undefined, undefined, dbPath);
    expect(second.hasCredential("imac-1")).toBe(false);
    second.close();
  });

  test("with no dbPath, behaves purely in-memory (no persistence)", () => {
    const service = new PairingService();
    service.requestPairing("imac-1");
    const pending = service.getPendingPairing("imac-1")!;
    service.approvePairing("imac-1", pending.code);
    service.close(); // must not throw with no backing db
  });
});
