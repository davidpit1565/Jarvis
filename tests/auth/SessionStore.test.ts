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
});
