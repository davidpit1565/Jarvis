import { describe, test, expect } from "bun:test";
import { listRunningApplicationsTool } from "@/tools/system/ListRunningApplicationsTool";
import { ToolRegistry } from "@/tools/registry/ToolRegistry";
import { PermissionLevel } from "@/types/permissions";

describe("LIST_RUNNING_APPLICATIONS tool definition", () => {
  test("is a device-targeted tool with no local execute()", () => {
    expect(listRunningApplicationsTool.target).toBe("device");
    expect("execute" in listRunningApplicationsTool).toBe(false);
  });

  test("requires READ permission", () => {
    expect(listRunningApplicationsTool.requiredPermission).toBe(PermissionLevel.READ);
  });

  test("accepts an optional deviceId", () => {
    expect(listRunningApplicationsTool.inputSchema.properties).toHaveProperty("deviceId");
    expect(listRunningApplicationsTool.inputSchema.required ?? []).not.toContain("deviceId");
  });

  test("registers cleanly and produces a Claude-compatible tool definition", () => {
    const registry = new ToolRegistry();
    registry.registerTool(listRunningApplicationsTool);

    const definitions = registry.toToolDefinitions();
    expect(definitions).toContainEqual({
      name: "list_running_applications",
      description: listRunningApplicationsTool.description,
      input_schema: listRunningApplicationsTool.inputSchema,
    });
  });
});
