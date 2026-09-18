import { describe, test, expect } from "bun:test";
import { openApplicationTool } from "@/tools/system/OpenApplicationTool";
import { ToolRegistry } from "@/tools/registry/ToolRegistry";
import { PermissionLevel } from "@/types/permissions";

describe("OPEN_APPLICATION tool definition", () => {
  test("is a device-targeted tool with no local execute()", () => {
    expect(openApplicationTool.target).toBe("device");
    expect("execute" in openApplicationTool).toBe(false);
  });

  test("requires SAFE_ACTION permission", () => {
    expect(openApplicationTool.requiredPermission).toBe(PermissionLevel.SAFE_ACTION);
  });

  test("requires applicationName, and accepts an optional deviceId", () => {
    expect(openApplicationTool.inputSchema.properties).toHaveProperty("applicationName");
    expect(openApplicationTool.inputSchema.required).toContain("applicationName");
    expect(openApplicationTool.inputSchema.properties).toHaveProperty("deviceId");
    expect(openApplicationTool.inputSchema.required ?? []).not.toContain("deviceId");
  });

  test("registers cleanly and produces a Claude-compatible tool definition", () => {
    const registry = new ToolRegistry();
    registry.registerTool(openApplicationTool);

    const definitions = registry.toToolDefinitions();
    expect(definitions).toContainEqual({
      name: "open_application",
      description: openApplicationTool.description,
      input_schema: openApplicationTool.inputSchema,
    });
  });
});
