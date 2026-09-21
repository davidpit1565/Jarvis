import { describe, test, expect } from "bun:test";
import { TwilioCostGuard } from "@/communication/phone/TwilioCostGuard";

describe("TwilioCostGuard", () => {
  test("allows uses up to the daily cap", () => {
    const guard = new TwilioCostGuard(3);

    expect(guard.tryConsume("2026-01-15")).toBe(true);
    expect(guard.tryConsume("2026-01-15")).toBe(true);
    expect(guard.tryConsume("2026-01-15")).toBe(true);
  });

  test("blocks a use once the daily cap is hit", () => {
    const guard = new TwilioCostGuard(2);

    expect(guard.tryConsume("2026-01-15")).toBe(true);
    expect(guard.tryConsume("2026-01-15")).toBe(true);
    expect(guard.tryConsume("2026-01-15")).toBe(false);
  });

  test("does not record a use when blocked", () => {
    const guard = new TwilioCostGuard(1);

    guard.tryConsume("2026-01-15");
    guard.tryConsume("2026-01-15");

    expect(guard.remaining("2026-01-15")).toBe(0);
  });

  test("resets the count on a new day", () => {
    const guard = new TwilioCostGuard(1);

    expect(guard.tryConsume("2026-01-15")).toBe(true);
    expect(guard.tryConsume("2026-01-15")).toBe(false);
    expect(guard.tryConsume("2026-01-16")).toBe(true);
  });

  test("remaining() reflects uses so far without consuming one", () => {
    const guard = new TwilioCostGuard(5);

    guard.tryConsume("2026-01-15");
    guard.tryConsume("2026-01-15");

    expect(guard.remaining("2026-01-15")).toBe(3);
    // Calling remaining() again doesn't itself consume anything.
    expect(guard.remaining("2026-01-15")).toBe(3);
  });

  test("remaining() never goes negative", () => {
    const guard = new TwilioCostGuard(1);
    guard.tryConsume("2026-01-15");
    guard.tryConsume("2026-01-15");

    expect(guard.remaining("2026-01-15")).toBe(0);
  });
});
