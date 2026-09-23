import { describe, test, expect } from "bun:test";
import { listRecentPhotosTool } from "@/tools/system/ListRecentPhotosTool";
import { ToolRegistry } from "@/tools/registry/ToolRegistry";
import { PermissionLevel } from "@/types/permissions";

describe("LIST_RECENT_PHOTOS tool definition", () => {
  test("is a device-targeted tool with no local execute()", () => {
    expect(listRecentPhotosTool.target).toBe("device");
    expect("execute" in listRecentPhotosTool).toBe(false);
  });

  test("requires only READ permission — listing metadata has no side effects", () => {
    expect(listRecentPhotosTool.requiredPermission).toBe(PermissionLevel.READ);
  });

  test("accepts an optional limit and deviceId, requires neither", () => {
    expect(listRecentPhotosTool.inputSchema.properties).toHaveProperty("limit");
    expect(listRecentPhotosTool.inputSchema.properties).toHaveProperty("deviceId");
    expect(listRecentPhotosTool.inputSchema.required ?? []).toEqual([]);
  });

  describe("validateInput (Core-side defense in depth)", () => {
    test("accepts an omitted limit", () => {
      expect(listRecentPhotosTool.validateInput?.({}).valid).toBe(true);
    });

    test("accepts a limit within the documented 1-50 range", () => {
      expect(listRecentPhotosTool.validateInput?.({ limit: 20 }).valid).toBe(true);
      expect(listRecentPhotosTool.validateInput?.({ limit: 1 }).valid).toBe(true);
      expect(listRecentPhotosTool.validateInput?.({ limit: 50 }).valid).toBe(true);
    });

    test("rejects a limit over the documented cap of 50", () => {
      expect(listRecentPhotosTool.validateInput?.({ limit: 51 }).valid).toBe(false);
      expect(listRecentPhotosTool.validateInput?.({ limit: 1_000_000 }).valid).toBe(false);
    });

    test("rejects a non-positive limit", () => {
      expect(listRecentPhotosTool.validateInput?.({ limit: 0 }).valid).toBe(false);
      expect(listRecentPhotosTool.validateInput?.({ limit: -5 }).valid).toBe(false);
    });

    test("rejects a non-integer or non-numeric limit", () => {
      expect(listRecentPhotosTool.validateInput?.({ limit: 20.5 }).valid).toBe(false);
      expect(listRecentPhotosTool.validateInput?.({ limit: "20" }).valid).toBe(false);
      expect(listRecentPhotosTool.validateInput?.({ limit: Infinity }).valid).toBe(false);
    });
  });

  test("registers cleanly and produces a Claude-compatible tool definition", () => {
    const registry = new ToolRegistry();
    registry.registerTool(listRecentPhotosTool);

    const definitions = registry.toToolDefinitions();
    expect(definitions).toContainEqual({
      name: "list_recent_photos",
      description: listRecentPhotosTool.description,
      input_schema: listRecentPhotosTool.inputSchema,
    });
  });
});
