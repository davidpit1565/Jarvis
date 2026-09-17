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

export const ToolTarget = {
  /** Executes in-process, inside JARVIS Core. */
  LOCAL: "local",
  /** Executes on a remote device agent via the WebSocket protocol. */
  DEVICE: "device",
} as const;

export type ToolTarget = (typeof ToolTarget)[keyof typeof ToolTarget];

interface BaseTool {
  id: string;
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  requiredPermission: PermissionLevel;
}

export interface LocalTool<TInput extends Record<string, unknown> = Record<string, unknown>> extends BaseTool {
  target: "local";
  execute(input: TInput, context: ToolExecutionContext): Promise<ToolResult>;
}

/**
 * A tool with no local implementation: the Orchestrator resolves a target
 * device (explicit `deviceId` input, or the primary device) and dispatches
 * it over the DeviceConnectionManager. There is deliberately no `execute`
 * here — Core never runs a device tool's logic itself.
 */
export interface DeviceTool extends BaseTool {
  target: "device";
}

export type Tool<TInput extends Record<string, unknown> = Record<string, unknown>> = LocalTool<TInput> | DeviceTool;

/** Shape handed to Claude describing an available tool. */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: ToolInputSchema;
}
