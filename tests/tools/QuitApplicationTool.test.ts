import { describe, test, expect } from "bun:test";
import { quitApplicationTool } from "@/tools/system/QuitApplicationTool";
import { ToolRegistry } from "@/tools/registry/ToolRegistry";
import { PermissionLevel } from "@/types/permissions";

describe("QUIT_APPLICATION tool definition", () => {
  test("is a device-targeted tool with no local execute()", () => {
    expect(quitApplicationTool.target).toBe("device");
    expect("execute" in quitApplicationTool).toBe(false);
  });

  test("requires SAFE_ACTION permission", () => {
    expect(quitApplicationTool.requiredPermission).toBe(PermissionLevel.SAFE_ACTION);
  });

  test("requires applicationName, and accepts an optional deviceId", () => {
    expect(quitApplicationTool.inputSchema.properties).toHaveProperty("applicationName");
    expect(quitApplicationTool.inputSchema.required).toContain("applicationName");
    expect(quitApplicationTool.inputSchema.properties).toHaveProperty("deviceId");
    expect(quitApplicationTool.inputSchema.required ?? []).not.toContain("deviceId");
  });

  test("registers cleanly and produces a Claude-compatible tool definition", () => {
    const registry = new ToolRegistry();
    registry.registerTool(quitApplicationTool);

    const definitions = registry.toToolDefinitions();
    expect(definitions).toContainEqual({
      name: "quit_application",
      description: quitApplicationTool.description,
      input_schema: quitApplicationTool.inputSchema,
    });
  });
});
