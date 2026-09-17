import type { PermissionLevel } from "./permissions";

/** Minimal JSON-schema-like shape, only what Claude's tool-use API needs. */
export interface ToolInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface ToolExecutionContext {
  userId: string;
  requestId: string;
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface Tool<TInput extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  requiredPermission: PermissionLevel;
  execute(input: TInput, context: ToolExecutionContext): Promise<ToolResult>;
}

/** Shape handed to Claude describing an available tool. */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: ToolInputSchema;
}
