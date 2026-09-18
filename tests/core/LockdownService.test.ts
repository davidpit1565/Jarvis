import { describe, test, expect } from "bun:test";
import { LockdownService } from "@/core/lockdown/LockdownService";

describe("LockdownService", () => {
  test("starts inactive", () => {
    const service = new LockdownService();
    expect(service.isActive()).toBe(false);
    expect(service.status()).toEqual({ active: false, reason: null, activatedAt: null });
  });

  test("activate() flips isActive() and records the reason and a timestamp", () => {
    const service = new LockdownService();
    service.activate("phone lost");

    expect(service.isActive()).toBe(true);
    const status = service.status();
    expect(status.active).toBe(true);
    expect(status.reason).toBe("phone lost");
    expect(status.activatedAt).not.toBeNull();
  });

  test("activate() without a reason leaves reason null", () => {
    const service = new LockdownService();
    service.activate();
    expect(service.status().reason).toBeNull();
  });

  test("deactivate() clears everything", () => {
    const service = new LockdownService();
    service.activate("test");
    service.deactivate();

    expect(service.isActive()).toBe(false);
    expect(service.status()).toEqual({ active: false, reason: null, activatedAt: null });
  });
});
