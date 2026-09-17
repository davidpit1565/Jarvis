import type { ToolCallRequest, ConversationMessage } from "./conversation";
import type { PermissionCheckResult } from "./permissions";
import type { Device } from "./devices";
import type { ToolResult } from "./tools";

export interface JarvisEventMap {
  "conversation.message": { message: ConversationMessage };
  "brain.request": { messageCount: number };
  "brain.response": { text: string; toolCallCount: number };
  "tool.requested": { toolCall: ToolCallRequest };
  "tool.executed": { toolName: string; requestId: string; result: ToolResult };
  "permission.checked": { toolId: string; result: PermissionCheckResult };
  "device.registered": { device: Device };
}

export type JarvisEventName = keyof JarvisEventMap;
