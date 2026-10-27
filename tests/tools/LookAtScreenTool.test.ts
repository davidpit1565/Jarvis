import { describe, test, expect } from "bun:test";
import { isLookAtScreenImageData, lookAtScreenTool, LOOK_AT_SCREEN_TOOL_NAME } from "@/tools/system/LookAtScreenTool";
import { ToolRegistry } from "@/tools/registry/ToolRegistry";
import { PermissionLevel } from "@/types/permissions";

describe("LOOK_AT_SCREEN tool definition", () => {
  test("is a device-targeted tool with no local execute()", () => {
    expect(lookAtScreenTool.target).toBe("device");
    expect("execute" in lookAtScreenTool).toBe(false);
  });

  test("requires CONFIRM permission, same tier as CAPTURE_SCREENSHOT", () => {
    expect(lookAtScreenTool.requiredPermission).toBe(PermissionLevel.CONFIRM);
  });

  test("name matches the exported constant used by the Orchestrator's vision bridge", () => {
    expect(lookAtScreenTool.name).toBe(LOOK_AT_SCREEN_TOOL_NAME);
    expect(lookAtScreenTool.name).toBe("look_at_screen");
  });

  test("accepts an optional deviceId and nothing required", () => {
    expect(lookAtScreenTool.inputSchema.properties).toHaveProperty("deviceId");
    expect(lookAtScreenTool.inputSchema.required ?? []).toHaveLength(0);
  });

  test("registers cleanly and produces a Claude-compatible tool definition", () => {
    const registry = new ToolRegistry();
    registry.registerTool(lookAtScreenTool);

    const definitions = registry.toToolDefinitions();
    expect(definitions).toContainEqual({
      name: "look_at_screen",
      description: lookAtScreenTool.description,
      input_schema: lookAtScreenTool.inputSchema,
    });
  });
});

describe("isLookAtScreenImageData", () => {
  test("accepts a well-formed payload", () => {
    expect(isLookAtScreenImageData({ mediaType: "image/jpeg", data: "abc123" })).toBe(true);
  });

  test("rejects a missing/wrong-type data field", () => {
    expect(isLookAtScreenImageData({ mediaType: "image/jpeg" })).toBe(false);
    expect(isLookAtScreenImageData({ mediaType: "image/jpeg", data: 123 })).toBe(false);
    expect(isLookAtScreenImageData({ mediaType: "image/jpeg", data: "" })).toBe(false);
  });

  test("rejects an unrecognized media type", () => {
    expect(isLookAtScreenImageData({ mediaType: "image/bmp", data: "abc123" })).toBe(false);
  });

  test("rejects a non-object value", () => {
    expect(isLookAtScreenImageData("not an object")).toBe(false);
    expect(isLookAtScreenImageData(undefined)).toBe(false);
    expect(isLookAtScreenImageData(null)).toBe(false);
  });
});
