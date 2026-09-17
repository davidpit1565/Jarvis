import { randomUUID } from "node:crypto";
import type { Brain } from "@/types/brain";
import type { ConversationManager } from "@/core/conversation/ConversationManager";
import type { ToolRegistry } from "@/tools/registry/ToolRegistry";
import type { PermissionService } from "@/permissions/PermissionService";
import type { EventBus } from "@/core/events/EventBus";
import type { ToolCallRequest } from "@/types/conversation";
import type { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import type { DeviceConnectionManager } from "@/communication/websocket/DeviceConnectionManager";
import type { DeviceTool, LocalTool, Tool, ToolResult } from "@/types/tools";
import { JARVIS_SYSTEM_PROMPT } from "@/core/brain/systemPrompt";

export interface OrchestratorDependencies {
  brain: Brain;
  conversation: ConversationManager;
  toolRegistry: ToolRegistry;
  permissionService: PermissionService;
  eventBus: EventBus;
  /** Required only if any registered tool has `target: "device"`. */
  deviceRegistry?: DeviceRegistry;
  deviceConnectionManager?: DeviceConnectionManager;
}

const MAX_TOOL_ITERATIONS = 5;

/**
 * The central JARVIS loop: user message -> Claude -> tool decision ->
 * permission check -> tool execution -> result back to Claude -> final
 * response. Claude only ever *requests* tools; this class is the sole
 * place that decides whether a tool actually runs, and whether it runs
 * locally in Core or is dispatched to a device agent.
 */
export class Orchestrator {
  constructor(private readonly deps: OrchestratorDependencies) {}

  async handleUserMessage(userId: string, content: string): Promise<string> {
    const { brain, conversation, toolRegistry, eventBus } = this.deps;

    conversation.addUserMessage(content);

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      eventBus.emit("brain.request", { messageCount: conversation.getMessages().length });

      const response = await brain.chat({
        messages: conversation.getMessages(),
        tools: toolRegistry.toToolDefinitions(),
        context: JARVIS_SYSTEM_PROMPT,
      });

      eventBus.emit("brain.response", {
        text: response.text,
        toolCallCount: response.toolCalls.length,
      });

      if (response.toolCalls.length === 0) {
        conversation.addAssistantMessage(response.text);
        return response.text;
      }

      conversation.addAssistantMessage(response.text, response.toolCalls);

      for (const toolCall of response.toolCalls) {
        await this.runToolCall(userId, toolCall);
      }
    }

    throw new Error(`Exceeded maximum tool iterations (${MAX_TOOL_ITERATIONS}) without a final response`);
  }

  private async runToolCall(userId: string, toolCall: ToolCallRequest): Promise<void> {
    const { toolRegistry, eventBus } = this.deps;

    eventBus.emit("tool.requested", { toolCall });

    const tool: Tool | undefined = toolRegistry.listTools().find((t) => t.name === toolCall.toolName);

    if (!tool) {
      this.completeToolCall(toolCall, { success: false, error: `Unknown tool: ${toolCall.toolName}` });
      return;
    }

    if (tool.target === "local") {
      await this.runLocalTool(userId, tool, toolCall);
      return;
    }

    await this.runDeviceTool(userId, tool, toolCall);
  }

  private async runLocalTool(userId: string, tool: LocalTool, toolCall: ToolCallRequest): Promise<void> {
    const { permissionService, eventBus } = this.deps;

    const permissionResult = permissionService.check({
      subject: { userId },
      toolId: tool.id,
      requiredLevel: tool.requiredPermission,
    });

    eventBus.emit("permission.checked", { toolId: tool.id, result: permissionResult });

    if (!permissionResult.allowed) {
      this.completeToolCall(toolCall, { success: false, error: `Permission denied: ${permissionResult.reason}` });
      return;
    }

    const requestId = randomUUID();
    const result = await tool.execute(toolCall.input, { userId, requestId });

    eventBus.emit("tool.executed", { toolName: tool.name, requestId, result });
    this.completeToolCall(toolCall, result);
  }

  private async runDeviceTool(userId: string, tool: DeviceTool, toolCall: ToolCallRequest): Promise<void> {
    const { permissionService, eventBus, deviceRegistry, deviceConnectionManager } = this.deps;

    if (!deviceRegistry || !deviceConnectionManager) {
      this.completeToolCall(toolCall, {
        success: false,
        error: "Device execution is not configured on this Orchestrator",
      });
      return;
    }

    const requestedDeviceId =
      typeof toolCall.input.deviceId === "string" ? (toolCall.input.deviceId as string) : undefined;

    const targetDevice = requestedDeviceId
      ? deviceRegistry.getDevice(requestedDeviceId)
      : deviceRegistry.getPrimaryDevice();

    if (!targetDevice) {
      const reason = requestedDeviceId ? `Unknown device: ${requestedDeviceId}` : "No primary device registered";
      this.completeToolCall(toolCall, { success: false, error: reason });
      return;
    }

    const permissionResult = permissionService.check({
      subject: { userId },
      toolId: tool.id,
      requiredLevel: tool.requiredPermission,
      deviceId: targetDevice.id,
    });

    eventBus.emit("permission.checked", { toolId: tool.id, result: permissionResult });

    if (!permissionResult.allowed) {
      this.completeToolCall(toolCall, { success: false, error: `Permission denied: ${permissionResult.reason}` });
      return;
    }

    try {
      const result = await deviceConnectionManager.sendToolRequest(targetDevice.id, tool.name, toolCall.input);
      eventBus.emit("tool.executed", { toolName: tool.name, requestId: toolCall.id, result });
      this.completeToolCall(toolCall, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Remote tool execution failed";
      this.completeToolCall(toolCall, { success: false, error: message });
    }
  }

  private completeToolCall(toolCall: ToolCallRequest, result: ToolResult): void {
    this.deps.conversation.addToolResult(toolCall.id, toolCall.toolName, JSON.stringify(result));
  }
}
