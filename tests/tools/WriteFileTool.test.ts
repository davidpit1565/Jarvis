import { describe, test, expect } from "bun:test";
import { writeFileTool } from "@/tools/system/WriteFileTool";
import { ToolRegistry } from "@/tools/registry/ToolRegistry";
import { PermissionLevel } from "@/types/permissions";

describe("WRITE_FILE tool definition", () => {
  test("is a device-targeted tool with no local execute()", () => {
    expect(writeFileTool.target).toBe("device");
    expect("execute" in writeFileTool).toBe(false);
  });

  test("requires CONFIRM permission — it can overwrite a file with no undo", () => {
    expect(writeFileTool.requiredPermission).toBe(PermissionLevel.CONFIRM);
  });

  test("requires path and base64Content, and accepts an optional deviceId", () => {
    expect(writeFileTool.inputSchema.properties).toHaveProperty("path");
    expect(writeFileTool.inputSchema.properties).toHaveProperty("base64Content");
    expect(writeFileTool.inputSchema.required).toEqual(["path", "base64Content"]);
    expect(writeFileTool.inputSchema.properties).toHaveProperty("deviceId");
    expect(writeFileTool.inputSchema.required ?? []).not.toContain("deviceId");
  });

  test("registers cleanly and produces a Claude-compatible tool definition", () => {
    const registry = new ToolRegistry();
    registry.registerTool(writeFileTool);

    const definitions = registry.toToolDefinitions();
    expect(definitions).toContainEqual({
      name: "write_file",
      description: writeFileTool.description,
      input_schema: writeFileTool.inputSchema,
    });
  });

  describe("validateInput (Core-side defense in depth)", () => {
    test("accepts a path inside an allowlisted folder", () => {
      expect(writeFileTool.validateInput?.({ path: "Desktop/notes.txt" }).valid).toBe(true);
    });

    test("rejects a traversal or absolute path before it ever reaches the device", () => {
      expect(writeFileTool.validateInput?.({ path: "Desktop/../../etc/passwd" }).valid).toBe(false);
      expect(writeFileTool.validateInput?.({ path: "/etc/passwd" }).valid).toBe(false);
    });
  });
});
