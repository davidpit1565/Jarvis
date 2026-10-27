import { describe, test, expect } from "bun:test";
import { ConfirmationPassphraseStore } from "@/security/ConfirmationPassphraseStore";

describe("ConfirmationPassphraseStore", () => {
  test("returns null before anything is set", () => {
    const store = new ConfirmationPassphraseStore(":memory:");
    expect(store.get()).toBeNull();
    store.close();
  });

  test("set() stores and get() retrieves it", () => {
    const store = new ConfirmationPassphraseStore(":memory:");
    store.set("open sesame");
    expect(store.get()).toBe("open sesame");
    store.close();
  });

  test("set() replaces a previously set passphrase", () => {
    const store = new ConfirmationPassphraseStore(":memory:");
    store.set("first");
    store.set("second");
    expect(store.get()).toBe("second");
    store.close();
  });

  test("seedIfEmpty sets the passphrase only when nothing is stored yet", () => {
    const store = new ConfirmationPassphraseStore(":memory:");
    store.seedIfEmpty("seeded value");
    expect(store.get()).toBe("seeded value");
    store.close();
  });

  test("seedIfEmpty never overrides an already-set passphrase", () => {
    const store = new ConfirmationPassphraseStore(":memory:");
    store.set("explicitly set");
    store.seedIfEmpty("seeded value");
    expect(store.get()).toBe("explicitly set");
    store.close();
  });

  test("seedIfEmpty is a no-op for an undefined/empty seed", () => {
    const store = new ConfirmationPassphraseStore(":memory:");
    store.seedIfEmpty(undefined);
    expect(store.get()).toBeNull();
    store.close();
  });
});
