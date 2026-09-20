import { describe, test, expect } from "bun:test";
import { listDirectoryTool } from "@/tools/system/ListDirectoryTool";
import { ToolRegistry } from "@/tools/registry/ToolRegistry";
import { PermissionLevel } from "@/types/permissions";

describe("LIST_DIRECTORY tool definition", () => {
  test("is a device-targeted tool with no local execute()", () => {
    expect(listDirectoryTool.target).toBe("device");
    expect("execute" in listDirectoryTool).toBe(false);
  });

  test("requires only READ permission — listing an allowlisted folder has no side effects", () => {
    expect(listDirectoryTool.requiredPermission).toBe(PermissionLevel.READ);
  });

  test("requires path, and accepts an optional deviceId", () => {
    expect(listDirectoryTool.inputSchema.properties).toHaveProperty("path");
    expect(listDirectoryTool.inputSchema.required).toContain("path");
    expect(listDirectoryTool.inputSchema.properties).toHaveProperty("deviceId");
    expect(listDirectoryTool.inputSchema.required ?? []).not.toContain("deviceId");
  });

  test("registers cleanly and produces a Claude-compatible tool definition", () => {
    const registry = new ToolRegistry();
    registry.registerTool(listDirectoryTool);

    const definitions = registry.toToolDefinitions();
    expect(definitions).toContainEqual({
      name: "list_directory",
      description: listDirectoryTool.description,
      input_schema: listDirectoryTool.inputSchema,
    });
  });

  describe("validateInput (Core-side defense in depth)", () => {
    test("accepts a path inside an allowlisted folder", () => {
      expect(listDirectoryTool.validateInput?.({ path: "Downloads" }).valid).toBe(true);
    });

    test("rejects a traversal or absolute path before it ever reaches the device", () => {
      expect(listDirectoryTool.validateInput?.({ path: "Desktop/../../etc" }).valid).toBe(false);
      expect(listDirectoryTool.validateInput?.({ path: "/etc" }).valid).toBe(false);
    });
  });
});
