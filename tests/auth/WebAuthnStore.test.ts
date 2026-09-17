import { describe, test, expect } from "bun:test";
import { WebAuthnStore } from "@/auth/WebAuthnStore";
import type { WebAuthnCredential } from "@simplewebauthn/server";

function makeCredential(id: string): WebAuthnCredential {
  return {
    id,
    publicKey: new Uint8Array([1, 2, 3, 4, 5]),
    counter: 0,
    transports: ["internal"],
  };
}

describe("WebAuthnStore", () => {
  test("starts empty", () => {
    const store = new WebAuthnStore();
    expect(store.list()).toEqual([]);
  });

  test("round-trips a saved credential, including its public key bytes", () => {
    const store = new WebAuthnStore();
    const credential = makeCredential("cred-1");
    store.save(credential);

    const fetched = store.get("cred-1");
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe("cred-1");
    expect(fetched!.counter).toBe(0);
    expect(fetched!.transports).toEqual(["internal"]);
    expect(Array.from(fetched!.publicKey)).toEqual([1, 2, 3, 4, 5]);
  });

  test("returns null for an unknown credential id", () => {
    const store = new WebAuthnStore();
    expect(store.get("nope")).toBeNull();
  });

  test("lists multiple credentials (e.g. a MacBook and an iPhone)", () => {
    const store = new WebAuthnStore();
    store.save(makeCredential("macbook"));
    store.save(makeCredential("iphone"));
    expect(store.list().map((c) => c.id).sort()).toEqual(["iphone", "macbook"]);
  });

  test("updateCounter persists the new counter value", () => {
    const store = new WebAuthnStore();
    store.save(makeCredential("cred-1"));
    store.updateCounter("cred-1", 42);
    expect(store.get("cred-1")!.counter).toBe(42);
  });
});
