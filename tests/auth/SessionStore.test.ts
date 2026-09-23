import { describe, test, expect } from "bun:test";
import { SessionStore } from "@/auth/SessionStore";

describe("SessionStore", () => {
  test("a freshly created session is valid", () => {
    const store = new SessionStore();
    const token = store.create();
    expect(store.isValid(token)).toBe(true);
  });

  test("an unknown token is invalid", () => {
    const store = new SessionStore();
    expect(store.isValid("nonexistent-token")).toBe(false);
  });

  test("null/undefined tokens are invalid", () => {
    const store = new SessionStore();
    expect(store.isValid(null)).toBe(false);
    expect(store.isValid(undefined)).toBe(false);
  });

  test("a session expires after its TTL", async () => {
    const store = new SessionStore(10); // 10ms TTL
    const token = store.create();
    expect(store.isValid(token)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.isValid(token)).toBe(false);
  });

  test("distinct sessions get distinct tokens", () => {
    const store = new SessionStore();
    const a = store.create();
    const b = store.create();
    expect(a).not.toBe(b);
  });

  test("revoke() invalidates a session immediately (logout)", () => {
    const store = new SessionStore();
    const token = store.create();
    expect(store.isValid(token)).toBe(true);

    store.revoke(token);

    expect(store.isValid(token)).toBe(false);
  });

  test("revoke() is a no-op for an unknown or null/undefined token", () => {
    const store = new SessionStore();
    expect(() => store.revoke("nonexistent-token")).not.toThrow();
    expect(() => store.revoke(null)).not.toThrow();
    expect(() => store.revoke(undefined)).not.toThrow();
  });

  test("a periodic sweep drops expired sessions instead of retaining them forever", async () => {
    const store = new SessionStore(10); // 10ms TTL
    const expiring: string[] = [];
    for (let i = 0; i < 19; i++) expiring.push(store.create());

    await new Promise((resolve) => setTimeout(resolve, 20));

    // The 20th create() crosses the sweep interval and should drop every
    // now-expired token above, not just the one being created.
    const fresh = store.create();

    const internalSessions = (store as unknown as { sessions: Map<string, number> }).sessions;
    for (const token of expiring) expect(internalSessions.has(token)).toBe(false);
    expect(store.isValid(fresh)).toBe(true);
  });
});
