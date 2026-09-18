import { describe, test, expect } from "bun:test";
import { createFolderTool } from "@/tools/system/CreateFolderTool";
import { ToolRegistry } from "@/tools/registry/ToolRegistry";
import { PermissionLevel } from "@/types/permissions";

describe("CREATE_FOLDER tool definition", () => {
  test("is a device-targeted tool with no local execute()", () => {
    expect(createFolderTool.target).toBe("device");
    expect("execute" in createFolderTool).toBe(false);
  });

  test("requires SAFE_ACTION permission — reversible, refuses to overwrite", () => {
    expect(createFolderTool.requiredPermission).toBe(PermissionLevel.SAFE_ACTION);
  });

  test("requires path, and accepts an optional deviceId", () => {
    expect(createFolderTool.inputSchema.properties).toHaveProperty("path");
    expect(createFolderTool.inputSchema.required).toContain("path");
    expect(createFolderTool.inputSchema.properties).toHaveProperty("deviceId");
    expect(createFolderTool.inputSchema.required ?? []).not.toContain("deviceId");
  });

  test("registers cleanly and produces a Claude-compatible tool definition", () => {
    const registry = new ToolRegistry();
    registry.registerTool(createFolderTool);

    const definitions = registry.toToolDefinitions();
    expect(definitions).toContainEqual({
      name: "create_folder",
      description: createFolderTool.description,
      input_schema: createFolderTool.inputSchema,
    });
  });

  describe("validateInput (Core-side defense in depth)", () => {
    test("accepts a path inside an allowlisted folder", () => {
      expect(createFolderTool.validateInput?.({ path: "Desktop/New Folder" }).valid).toBe(true);
    });

    test("rejects an empty path", () => {
      expect(createFolderTool.validateInput?.({ path: "" }).valid).toBe(false);
    });

    test("rejects a traversal or absolute path before it ever reaches the device", () => {
      expect(createFolderTool.validateInput?.({ path: "Desktop/../../etc" }).valid).toBe(false);
      expect(createFolderTool.validateInput?.({ path: "/etc/evil" }).valid).toBe(false);
    });

    test("rejects a top-level folder outside the allowlist", () => {
      expect(createFolderTool.validateInput?.({ path: "Library/evil" }).valid).toBe(false);
    });
  });
});
