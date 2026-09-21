import type { ToolCallRequest, ConversationMessage } from "./conversation";
import type { PermissionCheckResult } from "./permissions";
import type { Device, DeviceRole } from "./devices";
import type { ToolResult } from "./tools";
import type { TokenUsage } from "./brain";

export interface JarvisEventMap {
  "conversation.message": { message: ConversationMessage };
  "brain.request": { messageCount: number };
  "brain.response": { text: string; toolCallCount: number; serverToolUses?: string[]; usage?: TokenUsage };
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
  "device.roleGranted": { deviceId: string; role: DeviceRole };
  "device.revoked": { deviceId: string };
  /**
   * AIRouter switched away from its primary provider for this call:
   * "call-failed" (the primary's call threw), "budget-exceeded" (a
   * daily/monthly cost cap blocked a paid provider), "zero-cost-mode"
   * (ZERO_COST_MODE forbade a paid provider outright), or "circuit-open"
   * (the primary's circuit breaker is open after repeated failures).
   */
  "ai.providerFallback": {
    from: string;
    to: string;
    reason: "call-failed" | "budget-exceeded" | "zero-cost-mode" | "circuit-open";
  };
  /** An AgentCore task moved from one state to another — see src/agent/AgentTaskStateMachine.ts for the legal transitions. */
  "agent.task.transition": { taskId: string; userId: string; from: string; to: string; reason: string };
  /**
   * JARVIS's user-facing live state (see src/core/state/JarvisLiveState.ts)
   * moved from one value to another for a given session — roadmap items
   * 92-97/101-103 and the backend half of item 36. `sessionId` is the
   * opaque per-channel key (`${channel}:${userId}` by convention);
   * `userId` is included directly too so a consumer that only cares about
   * "this user" doesn't need to parse `sessionId`. `language`, when
   * present, is the reply language ("en" | "he") known for this session at
   * the time of the transition. Forwarded to WebSocket observer clients —
   * see JarvisWebSocketServer's OBSERVABLE_EVENTS list.
   */
  "jarvis.liveState.changed": {
    sessionId: string;
    userId: string;
    from: string;
    to: string;
    reason?: string;
    language?: "en" | "he";
    timestamp: number;
  };
}

export type JarvisEventName = keyof JarvisEventMap;
