import { describe, test, expect } from "bun:test";
import { readFileBytesTool } from "@/tools/system/ReadFileBytesTool";
import { ToolRegistry } from "@/tools/registry/ToolRegistry";
import { PermissionLevel } from "@/types/permissions";

describe("READ_FILE_BYTES tool definition", () => {
  test("is a device-targeted tool with no local execute()", () => {
    expect(readFileBytesTool.target).toBe("device");
    expect("execute" in readFileBytesTool).toBe(false);
  });

  test("requires only READ permission — reading an allowlisted file has no side effects", () => {
    expect(readFileBytesTool.requiredPermission).toBe(PermissionLevel.READ);
  });

  test("requires path, and accepts an optional deviceId", () => {
    expect(readFileBytesTool.inputSchema.properties).toHaveProperty("path");
    expect(readFileBytesTool.inputSchema.required).toContain("path");
    expect(readFileBytesTool.inputSchema.properties).toHaveProperty("deviceId");
    expect(readFileBytesTool.inputSchema.required ?? []).not.toContain("deviceId");
  });

  test("registers cleanly and produces a Claude-compatible tool definition", () => {
    const registry = new ToolRegistry();
    registry.registerTool(readFileBytesTool);

    const definitions = registry.toToolDefinitions();
    expect(definitions).toContainEqual({
      name: "read_file_bytes",
      description: readFileBytesTool.description,
      input_schema: readFileBytesTool.inputSchema,
    });
  });

  describe("validateInput (Core-side defense in depth)", () => {
    test("accepts a path inside an allowlisted folder", () => {
      expect(readFileBytesTool.validateInput?.({ path: "Desktop/notes.txt" }).valid).toBe(true);
    });

    test("rejects a traversal or absolute path before it ever reaches the device", () => {
      expect(readFileBytesTool.validateInput?.({ path: "Desktop/../../etc/passwd" }).valid).toBe(false);
      expect(readFileBytesTool.validateInput?.({ path: "/etc/passwd" }).valid).toBe(false);
    });
  });
});
