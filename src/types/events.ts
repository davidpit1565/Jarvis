import type { ToolCallRequest, ConversationMessage } from "./conversation";
import type { PermissionCheckResult } from "./permissions";
import type { Device } from "./devices";
import type { ToolResult } from "./tools";

export interface JarvisEventMap {
  "conversation.message": { message: ConversationMessage };
  "brain.request": { messageCount: number };
  "brain.response": { text: string; toolCallCount: number; serverToolUses?: string[] };
  "tool.requested": { toolCall: ToolCallRequest };
  "tool.executed": {
    toolName: string;
    requestId: string;
    result: ToolResult;
    userId: string;
    input: Record<string, unknown>;
  };
  "tool.dispatched": { toolName: string; deviceId: string; requestId: string };
  "permission.checked": { toolId: string; result: PermissionCheckResult };
  "device.registered": { device: Device };
  "device.connected": { deviceId: string };
  "device.disconnected": { deviceId: string; reason: string };
}

export type JarvisEventName = keyof JarvisEventMap;
