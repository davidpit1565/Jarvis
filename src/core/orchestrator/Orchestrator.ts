import { randomUUID } from "node:crypto";
import type { Brain } from "@/types/brain";
import type { ConversationManager } from "@/core/conversation/ConversationManager";
import type { ToolRegistry } from "@/tools/registry/ToolRegistry";
import type { PermissionService } from "@/permissions/PermissionService";
import type { EventBus } from "@/core/events/EventBus";
import type { ToolCallRequest } from "@/types/conversation";

export interface OrchestratorDependencies {
  brain: Brain;
  conversation: ConversationManager;
  toolRegistry: ToolRegistry;
  permissionService: PermissionService;
  eventBus: EventBus;
}

const MAX_TOOL_ITERATIONS = 5;

/**
 * The central JARVIS loop: user message -> Claude -> tool decision ->
 * permission check -> tool execution -> result back to Claude -> final
 * response. Claude only ever *requests* tools; this class is the sole
 * place that decides whether a tool actually runs.
 */
export class Orchestrator {
  constructor(private readonly deps: OrchestratorDependencies) {}

  async handleUserMessage(userId: string, content: string): Promise<string> {
    const { brain, conversation, toolRegistry, permissionService, eventBus } = this.deps;

    conversation.addUserMessage(content);

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      eventBus.emit("brain.request", { messageCount: conversation.getMessages().length });

      const response = await brain.chat({
        messages: conversation.getMessages(),
        tools: toolRegistry.toToolDefinitions(),
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
    const { toolRegistry, permissionService, conversation, eventBus } = this.deps;

    eventBus.emit("tool.requested", { toolCall });

    const tool = toolRegistry.listTools().find((t) => t.name === toolCall.toolName);

    if (!tool) {
      conversation.addToolResult(
        toolCall.id,
        toolCall.toolName,
        JSON.stringify({ success: false, error: `Unknown tool: ${toolCall.toolName}` })
      );
      return;
    }

    const permissionResult = permissionService.check({
      subject: { userId },
      toolId: tool.id,
      requiredLevel: tool.requiredPermission,
    });

    eventBus.emit("permission.checked", { toolId: tool.id, result: permissionResult });

    if (!permissionResult.allowed) {
      conversation.addToolResult(
        toolCall.id,
        toolCall.toolName,
        JSON.stringify({ success: false, error: `Permission denied: ${permissionResult.reason}` })
      );
      return;
    }

    const requestId = randomUUID();
    const result = await tool.execute(toolCall.input, { userId, requestId });

    eventBus.emit("tool.executed", { toolName: tool.name, requestId, result });

    conversation.addToolResult(toolCall.id, toolCall.toolName, JSON.stringify(result));
  }
}
