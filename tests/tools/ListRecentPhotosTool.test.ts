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
