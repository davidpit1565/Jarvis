import { describe, test, expect } from "bun:test";
import { ToolRegistry } from "@/tools/registry/ToolRegistry";
import { PermissionLevel } from "@/types/permissions";
import type { Tool } from "@/types/tools";

function makeTool(id: string, name: string): Tool {
  return {
    id,
    name,
    description: `Test tool ${name}`,
    inputSchema: { type: "object", properties: {} },
    requiredPermission: PermissionLevel.READ,
    execute: async () => ({ success: true }),
  };
}

describe("ToolRegistry", () => {
  test("registers and retrieves a tool by id", () => {
    const registry = new ToolRegistry();
    const tool = makeTool("TEST_TOOL", "test_tool");
    registry.registerTool(tool);

    expect(registry.getTool("TEST_TOOL")).toBe(tool);
  });

  test("returns undefined for unknown tool id", () => {
    const registry = new ToolRegistry();
    expect(registry.getTool("MISSING")).toBeUndefined();
  });

  test("lists all registered tools", () => {
    const registry = new ToolRegistry();
    registry.registerTool(makeTool("A", "a"));
    registry.registerTool(makeTool("B", "b"));

    expect(registry.listTools()).toHaveLength(2);
  });

  test("throws when registering a duplicate tool id", () => {
    const registry = new ToolRegistry();
    registry.registerTool(makeTool("DUP", "dup"));

    expect(() => registry.registerTool(makeTool("DUP", "dup-2"))).toThrow();
  });

  test("produces Claude-compatible tool definitions", () => {
    const registry = new ToolRegistry();
    registry.registerTool(makeTool("A", "a"));

    const definitions = registry.toToolDefinitions();
    expect(definitions).toEqual([
      { name: "a", description: "Test tool a", input_schema: { type: "object", properties: {} } },
    ]);
  });
});
