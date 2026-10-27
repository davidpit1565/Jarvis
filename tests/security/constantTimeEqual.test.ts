import { describe, test, expect } from "bun:test";
import { constantTimeEqual } from "@/security/constantTimeEqual";

describe("constantTimeEqual", () => {
  test("true for identical strings", () => {
    expect(constantTimeEqual("open sesame", "open sesame")).toBe(true);
  });

  test("false for different strings of the same length", () => {
    expect(constantTimeEqual("open sesame", "close sesam")).toBe(false);
  });

  test("false for different-length strings, without throwing", () => {
    expect(constantTimeEqual("short", "a much longer string")).toBe(false);
  });

  test("false when only the first character differs (would short-circuit fastest under naive ===)", () => {
    expect(constantTimeEqual("xpen sesame", "open sesame")).toBe(false);
  });

  test("false when only the last character differs (would short-circuit slowest under naive ===)", () => {
    expect(constantTimeEqual("open sesama", "open sesame")).toBe(false);
  });

  test("empty strings are equal to each other, not to non-empty ones", () => {
    expect(constantTimeEqual("", "")).toBe(true);
    expect(constantTimeEqual("", "x")).toBe(false);
  });
});
