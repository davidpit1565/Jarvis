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

    // Roadmap #84 (WRITE_FILE boundary test): the Core-side gate is what's
    // verifiable today without a real Mac — the Swift-side re-check
    // (FileAccessPolicy.resolve(), which additionally resolves symlinks
    // before comparing against the allowlisted roots) can't be exercised
    // here and remains REQUIRES_REAL_MAC_VALIDATION.
    test("rejects a null byte in the path", () => {
      expect(writeFileTool.validateInput?.({ path: "Desktop/notes.txt\0.jpg" }).valid).toBe(false);
    });

    test("rejects a home-relative shorthand", () => {
      expect(writeFileTool.validateInput?.({ path: "~/Desktop/notes.txt" }).valid).toBe(false);
    });

    test("rejects writing into a top-level folder outside the allowlist", () => {
      expect(writeFileTool.validateInput?.({ path: "Library/LaunchAgents/evil.plist" }).valid).toBe(false);
      expect(writeFileTool.validateInput?.({ path: ".ssh/authorized_keys" }).valid).toBe(false);
    });

    test("rejects a top-level folder name that only superficially resembles an allowlisted one", () => {
      expect(writeFileTool.validateInput?.({ path: "Desktop-shared/notes.txt" }).valid).toBe(false);
    });

    test("still requires CONFIRM even for a path validateInput accepts — validation is a filter, not a substitute for confirmation", () => {
      const result = writeFileTool.validateInput?.({ path: "Desktop/notes.txt" });
      expect(result?.valid).toBe(true);
      // The permission level itself never changes based on the specific
      // input — every write, valid path or not, still requires a fresh
      // human confirmation (see the `requiredPermission` test above).
      expect(writeFileTool.requiredPermission).toBe(PermissionLevel.CONFIRM);
    });
  });
});
