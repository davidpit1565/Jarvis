import { describe, test, expect } from "bun:test";
import { openCameraTool } from "@/tools/system/OpenCameraTool";
import { ToolRegistry } from "@/tools/registry/ToolRegistry";
import { PermissionLevel } from "@/types/permissions";

describe("OPEN_CAMERA tool definition", () => {
  test("is a device-targeted tool with no local execute()", () => {
    expect(openCameraTool.target).toBe("device");
    expect("execute" in openCameraTool).toBe(false);
  });

  test("requires CONFIRM permission (same tier as CAPTURE_SCREENSHOT)", () => {
    expect(openCameraTool.requiredPermission).toBe(PermissionLevel.CONFIRM);
  });

  test("accepts an optional deviceId and nothing is required", () => {
    expect(openCameraTool.inputSchema.properties).toHaveProperty("deviceId");
    expect(openCameraTool.inputSchema.required ?? []).toHaveLength(0);
  });

  test("registers cleanly and produces a Claude-compatible tool definition", () => {
    const registry = new ToolRegistry();
    registry.registerTool(openCameraTool);

    const definitions = registry.toToolDefinitions();
    expect(definitions).toContainEqual({
      name: "open_camera",
      description: openCameraTool.description,
      input_schema: openCameraTool.inputSchema,
    });
  });
});
