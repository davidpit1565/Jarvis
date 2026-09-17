import type { Tool, ToolDefinition } from "@/types/tools";

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  registerTool(tool: Tool): void {
    if (this.tools.has(tool.id)) {
      throw new Error(`Tool with id "${tool.id}" is already registered`);
    }
    this.tools.set(tool.id, tool);
  }

  getTool(id: string): Tool | undefined {
    return this.tools.get(id);
  }

  listTools(): Tool[] {
    return Array.from(this.tools.values());
  }

  /** Produces the tool definitions Claude needs to decide what to call. */
  toToolDefinitions(): ToolDefinition[] {
    return this.listTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
  }
}
