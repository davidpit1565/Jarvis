import { describe, test, expect } from "bun:test";
import {
  buildScreenVisionMessage,
  extractScreenVisionImage,
  redactScreenVisionPayload,
} from "@/core/orchestrator/screenVisionBridge";
import type { ToolCallRequest } from "@/types/conversation";
import type { ToolResult } from "@/types/tools";

const lookCall: ToolCallRequest = { id: "call-1", toolName: "look_at_screen", input: {} };
const otherCall: ToolCallRequest = { id: "call-2", toolName: "get_weather", input: {} };

describe("extractScreenVisionImage", () => {
  test("extracts a well-formed successful LOOK_AT_SCREEN result", () => {
    const result: ToolResult = { success: true, data: { mediaType: "image/jpeg", data: "abc123" } };
    expect(extractScreenVisionImage(lookCall, result, 1_000)).toEqual({ mediaType: "image/jpeg", data: "abc123" });
  });

  test("returns undefined for any other tool", () => {
    const result: ToolResult = { success: true, data: { mediaType: "image/jpeg", data: "abc123" } };
    expect(extractScreenVisionImage(otherCall, result, 1_000)).toBeUndefined();
  });

  test("returns undefined for a failed result", () => {
    const result: ToolResult = { success: false, error: "capture failed" };
    expect(extractScreenVisionImage(lookCall, result, 1_000)).toBeUndefined();
  });

  test("returns undefined for a malformed data payload (missing/wrong-typed fields)", () => {
    expect(extractScreenVisionImage(lookCall, { success: true, data: {} }, 1_000)).toBeUndefined();
    expect(extractScreenVisionImage(lookCall, { success: true, data: { mediaType: "image/jpeg" } }, 1_000)).toBeUndefined();
    expect(extractScreenVisionImage(lookCall, { success: true, data: "not an object" }, 1_000)).toBeUndefined();
  });

  test("returns undefined for an unrecognized media type", () => {
    const result: ToolResult = { success: true, data: { mediaType: "image/bmp", data: "abc123" } };
    expect(extractScreenVisionImage(lookCall, result, 1_000)).toBeUndefined();
  });

  test("degrades gracefully (returns undefined, never throws) when the base64 payload exceeds the size cap", () => {
    const oversized = "x".repeat(2_000);
    const result: ToolResult = { success: true, data: { mediaType: "image/jpeg", data: oversized } };
    expect(() => extractScreenVisionImage(lookCall, result, 1_000)).not.toThrow();
    expect(extractScreenVisionImage(lookCall, result, 1_000)).toBeUndefined();
  });
});

describe("redactScreenVisionPayload", () => {
  test("replaces the base64 payload with a placeholder for a successful LOOK_AT_SCREEN result", () => {
    const result: ToolResult = { success: true, data: { mediaType: "image/jpeg", data: "abc123", sizeBytes: 42 } };
    const redacted = redactScreenVisionPayload(lookCall, result);

    expect(redacted.success).toBe(true);
    const data = redacted.data as Record<string, unknown>;
    expect(data.data).not.toBe("abc123");
    expect(typeof data.data).toBe("string");
    expect(data.mediaType).toBe("image/jpeg");
    expect(data.sizeBytes).toBe(42);
  });

  test("leaves any other tool's result completely unchanged", () => {
    const result: ToolResult = { success: true, data: { application: "Google Chrome" } };
    expect(redactScreenVisionPayload(otherCall, result)).toEqual(result);
  });

  test("leaves a failed LOOK_AT_SCREEN result unchanged", () => {
    const result: ToolResult = { success: false, error: "capture failed" };
    expect(redactScreenVisionPayload(lookCall, result)).toEqual(result);
  });

  test("leaves a malformed successful result unchanged rather than throwing", () => {
    const result: ToolResult = { success: true, data: { unexpected: "shape" } };
    expect(() => redactScreenVisionPayload(lookCall, result)).not.toThrow();
    expect(redactScreenVisionPayload(lookCall, result)).toEqual(result);
  });
});

describe("buildScreenVisionMessage", () => {
  test("builds a role:user message carrying the given images", () => {
    const images = [{ mediaType: "image/jpeg" as const, data: "abc123" }];
    const message = buildScreenVisionMessage(images);

    expect(message.role).toBe("user");
    expect(message.images).toEqual(images);
    expect(typeof message.content).toBe("string");
    expect(message.content.length).toBeGreaterThan(0);
  });
});
