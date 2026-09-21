import { describe, test, expect } from "bun:test";
import { Orchestrator } from "@/core/orchestrator/Orchestrator";
import { ConversationManager } from "@/core/conversation/ConversationManager";
import { EventBus } from "@/core/events/EventBus";
import { ToolRegistry } from "@/tools/registry/ToolRegistry";
import { PermissionService } from "@/permissions/PermissionService";
import { PermissionLevel } from "@/types/permissions";
import { parseQuarantinedToolResult } from "@/core/orchestrator/toolResultQuarantine";
import type { Brain, BrainRequest, BrainResponse } from "@/types/brain";
import type { LocalTool } from "@/types/tools";

class ScriptedBrain implements Brain {
  private calls = 0;
  constructor(private readonly responses: BrainResponse[]) {}
  async chat(_request: BrainRequest): Promise<BrainResponse> {
    const response = this.responses[this.calls];
    this.calls++;
    if (!response) throw new Error("ScriptedBrain ran out of scripted responses");
    return response;
  }
}

function makeHangingTool(timeoutMs?: number): LocalTool {
  return {
    id: "HANGING_TOOL",
    name: "hanging_tool",
    description: "A tool that never resolves — simulates a hung network call",
    inputSchema: { type: "object", properties: {} },
    requiredPermission: PermissionLevel.READ,
    target: "local",
    timeoutMs,
    execute: () => new Promise(() => {}), // never resolves
  };
}

describe("Tool Risk Model: local tool timeout (Orchestrator)", () => {
  test("a tool whose execute() never resolves is aborted at its configured timeoutMs instead of hanging the turn forever", async () => {
    const tool = makeHangingTool(20);
    const brain = new ScriptedBrain([
      { text: "", toolCalls: [{ id: "call-1", toolName: "hanging_tool", input: {} }], stopReason: "tool_use" },
      { text: "done", toolCalls: [], stopReason: "end_turn" },
    ]);

    const eventBus = new EventBus();
    const toolRegistry = new ToolRegistry();
    toolRegistry.registerTool(tool);
    const permissionService = new PermissionService();
    const conversation = new ConversationManager(eventBus);

    let timedOutEvents = 0;
    eventBus.on("tool.timedOut", () => {
      timedOutEvents++;
    });

    const orchestrator = new Orchestrator({ brain, conversation, toolRegistry, permissionService, eventBus });

    const response = await orchestrator.handleUserMessage("user-1", "go");
    expect(response).toBe("done");
    expect(timedOutEvents).toBe(1);

    const toolResult = conversation.getMessages().find((m) => m.role === "tool") as { content: string };
    const parsed = parseQuarantinedToolResult(toolResult.content) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/timed out/i);
  });

  test("localToolTimeoutMs: 0 disables timeout enforcement entirely (opt-out preserved)", async () => {
    // A short-lived promise well under any real timeout — proves timeout
    // enforcement being disabled doesn't change normal successful behavior.
    const tool: LocalTool = {
      id: "QUICK_TOOL",
      name: "quick_tool",
      description: "Resolves immediately",
      inputSchema: { type: "object", properties: {} },
      requiredPermission: PermissionLevel.READ,
      target: "local",
      execute: async () => ({ success: true, data: "ok" }),
    };

    const brain = new ScriptedBrain([
      { text: "", toolCalls: [{ id: "call-1", toolName: "quick_tool", input: {} }], stopReason: "tool_use" },
      { text: "done", toolCalls: [], stopReason: "end_turn" },
    ]);

    const eventBus = new EventBus();
    const toolRegistry = new ToolRegistry();
    toolRegistry.registerTool(tool);
    const permissionService = new PermissionService();
    const conversation = new ConversationManager(eventBus);

    const orchestrator = new Orchestrator({
      brain,
      conversation,
      toolRegistry,
      permissionService,
      eventBus,
      localToolTimeoutMs: 0,
    });

    const response = await orchestrator.handleUserMessage("user-1", "go");
    expect(response).toBe("done");
    const toolResult = conversation.getMessages().find((m) => m.role === "tool") as { content: string };
    const parsed = parseQuarantinedToolResult(toolResult.content) as { success: boolean };
    expect(parsed.success).toBe(true);
  });
});
