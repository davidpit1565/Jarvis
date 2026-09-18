import { describe, test, expect } from "bun:test";
import { openUrlTool } from "@/tools/system/OpenUrlTool";
import { ToolRegistry } from "@/tools/registry/ToolRegistry";
import { PermissionLevel } from "@/types/permissions";

describe("OPEN_URL tool definition", () => {
  test("is a device-targeted tool with no local execute()", () => {
    expect(openUrlTool.target).toBe("device");
    expect("execute" in openUrlTool).toBe(false);
  });

  test("requires SAFE_ACTION permission", () => {
    expect(openUrlTool.requiredPermission).toBe(PermissionLevel.SAFE_ACTION);
  });

  test("requires url, and accepts an optional deviceId", () => {
    expect(openUrlTool.inputSchema.properties).toHaveProperty("url");
    expect(openUrlTool.inputSchema.required).toContain("url");
    expect(openUrlTool.inputSchema.properties).toHaveProperty("deviceId");
    expect(openUrlTool.inputSchema.required ?? []).not.toContain("deviceId");
  });

  test("registers cleanly and produces a Claude-compatible tool definition", () => {
    const registry = new ToolRegistry();
    registry.registerTool(openUrlTool);

    const definitions = registry.toToolDefinitions();
    expect(definitions).toContainEqual({
      name: "open_url",
      description: openUrlTool.description,
      input_schema: openUrlTool.inputSchema,
    });
  });
});
