import { describe, test, expect } from "bun:test";
import { closeCameraTool } from "@/tools/system/CloseCameraTool";
import { ToolRegistry } from "@/tools/registry/ToolRegistry";
import { PermissionLevel } from "@/types/permissions";

describe("CLOSE_CAMERA tool definition", () => {
  test("is a device-targeted tool with no local execute()", () => {
    expect(closeCameraTool.target).toBe("device");
    expect("execute" in closeCameraTool).toBe(false);
  });

  test("requires SAFE_ACTION permission", () => {
    expect(closeCameraTool.requiredPermission).toBe(PermissionLevel.SAFE_ACTION);
  });

  test("accepts an optional deviceId and nothing is required", () => {
    expect(closeCameraTool.inputSchema.properties).toHaveProperty("deviceId");
    expect(closeCameraTool.inputSchema.required ?? []).toHaveLength(0);
  });

  test("registers cleanly and produces a Claude-compatible tool definition", () => {
    const registry = new ToolRegistry();
    registry.registerTool(closeCameraTool);

    const definitions = registry.toToolDefinitions();
    expect(definitions).toContainEqual({
      name: "close_camera",
      description: closeCameraTool.description,
      input_schema: closeCameraTool.inputSchema,
    });
  });
});
