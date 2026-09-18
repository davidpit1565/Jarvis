import { describe, test, expect } from "bun:test";
import { RateLimiter } from "@/communication/websocket/RateLimiter";

describe("RateLimiter", () => {
  test("allows attempts up to the limit", () => {
    const limiter = new RateLimiter(3, 60_000);
    expect(limiter.attempt("k")).toBe(true);
    expect(limiter.attempt("k")).toBe(true);
    expect(limiter.attempt("k")).toBe(true);
  });

  test("blocks once the limit is exceeded", () => {
    const limiter = new RateLimiter(3, 60_000);
    limiter.attempt("k");
    limiter.attempt("k");
    limiter.attempt("k");
    expect(limiter.attempt("k")).toBe(false);
  });

  test("different keys have independent limits", () => {
    const limiter = new RateLimiter(1, 60_000);
    expect(limiter.attempt("a")).toBe(true);
    expect(limiter.attempt("b")).toBe(true);
    expect(limiter.attempt("a")).toBe(false);
  });

  test("allows attempts again once the window has passed", () => {
    const limiter = new RateLimiter(1, 10);
    expect(limiter.attempt("k")).toBe(true);
    expect(limiter.attempt("k")).toBe(false);
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(limiter.attempt("k")).toBe(true);
        resolve();
      }, 20);
    });
  });

  test("periodically sweeps out keys whose attempts have all aged out, bounding memory growth", () => {
    const limiter = new RateLimiter(5, 10);
    const hits = (limiter as unknown as { hits: Map<string, number[]> }).hits;

    // 499 distinct keys, each hit once — all stale by the time the window (10ms) passes.
    for (let i = 0; i < 499; i++) {
      limiter.attempt(`key-${i}`);
    }
    expect(hits.size).toBe(499);

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        // This is the 500th attempt overall, crossing the sweep threshold —
        // it should drop every key whose attempts are now all outside the
        // window, leaving only this call's own fresh entry behind.
        limiter.attempt("trigger-sweep");
        expect(hits.size).toBeLessThan(499);
        resolve();
      }, 20);
    });
  });
});
