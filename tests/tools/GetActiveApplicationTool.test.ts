import { describe, test, expect } from "bun:test";
import { getActiveApplicationTool } from "@/tools/system/GetActiveApplicationTool";
import { ToolRegistry } from "@/tools/registry/ToolRegistry";
import { PermissionLevel } from "@/types/permissions";

describe("GET_ACTIVE_APPLICATION tool definition", () => {
  test("is a device-targeted tool with no local execute()", () => {
    expect(getActiveApplicationTool.target).toBe("device");
    expect("execute" in getActiveApplicationTool).toBe(false);
  });

  test("requires only READ permission", () => {
    expect(getActiveApplicationTool.requiredPermission).toBe(PermissionLevel.READ);
  });

  test("accepts an optional deviceId input and nothing else required", () => {
    expect(getActiveApplicationTool.inputSchema.properties).toHaveProperty("deviceId");
    expect(getActiveApplicationTool.inputSchema.required ?? []).not.toContain("deviceId");
  });

  test("registers cleanly and produces a Claude-compatible tool definition", () => {
    const registry = new ToolRegistry();
    registry.registerTool(getActiveApplicationTool);

    const definitions = registry.toToolDefinitions();
    expect(definitions).toContainEqual({
      name: "get_active_application",
      description: getActiveApplicationTool.description,
      input_schema: getActiveApplicationTool.inputSchema,
    });
  });
});
