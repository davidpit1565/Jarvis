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
});
