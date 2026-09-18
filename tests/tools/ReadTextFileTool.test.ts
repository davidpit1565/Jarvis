import { describe, test, expect } from "bun:test";
import { readTextFileTool } from "@/tools/system/ReadTextFileTool";
import { ToolRegistry } from "@/tools/registry/ToolRegistry";
import { PermissionLevel } from "@/types/permissions";

describe("READ_TEXT_FILE tool definition", () => {
  test("is a device-targeted tool with no local execute()", () => {
    expect(readTextFileTool.target).toBe("device");
    expect("execute" in readTextFileTool).toBe(false);
  });

  test("requires only READ permission — reading an allowlisted text file has no side effects", () => {
    expect(readTextFileTool.requiredPermission).toBe(PermissionLevel.READ);
  });

  test("requires path, and accepts an optional deviceId", () => {
    expect(readTextFileTool.inputSchema.properties).toHaveProperty("path");
    expect(readTextFileTool.inputSchema.required).toContain("path");
    expect(readTextFileTool.inputSchema.properties).toHaveProperty("deviceId");
    expect(readTextFileTool.inputSchema.required ?? []).not.toContain("deviceId");
  });

  test("registers cleanly and produces a Claude-compatible tool definition", () => {
    const registry = new ToolRegistry();
    registry.registerTool(readTextFileTool);

    const definitions = registry.toToolDefinitions();
    expect(definitions).toContainEqual({
      name: "read_text_file",
      description: readTextFileTool.description,
      input_schema: readTextFileTool.inputSchema,
    });
  });
});
