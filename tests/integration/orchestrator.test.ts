import { describe, test, expect } from "bun:test";
import { Orchestrator } from "@/core/orchestrator/Orchestrator";
import { ConversationManager } from "@/core/conversation/ConversationManager";
import { EventBus } from "@/core/events/EventBus";
import { ToolRegistry } from "@/tools/registry/ToolRegistry";
import { PermissionService } from "@/permissions/PermissionService";
import { PermissionLevel } from "@/types/permissions";
import type { Brain, BrainRequest, BrainResponse } from "@/types/brain";
import type { Tool } from "@/types/tools";

/** Scripted mock brain: returns queued responses in order, one per call. */
class ScriptedBrain implements Brain {
  private calls = 0;
  constructor(private readonly responses: BrainResponse[]) {}

  async chat(_request: BrainRequest): Promise<BrainResponse> {
    const response = this.responses[this.calls];
    this.calls++;
    if (!response) {
      throw new Error("ScriptedBrain ran out of scripted responses");
    }
    return response;
  }

  get callCount() {
    return this.calls;
  }
}

function makeEchoTool(id: string, requiredPermission: Tool["requiredPermission"] = PermissionLevel.READ): Tool {
  return {
    id,
    name: id.toLowerCase(),
    description: "Echoes its input back",
    inputSchema: { type: "object", properties: {} },
    requiredPermission,
    execute: async (input) => ({ success: true, data: input }),
  };
}

function setup(brain: Brain, tools: Tool[] = []) {
  const eventBus = new EventBus();
  const toolRegistry = new ToolRegistry();
  for (const tool of tools) toolRegistry.registerTool(tool);
  const permissionService = new PermissionService();
  const conversation = new ConversationManager(eventBus);

  const orchestrator = new Orchestrator({ brain, conversation, toolRegistry, permissionService, eventBus });
  return { orchestrator, conversation, eventBus, toolRegistry, permissionService };
}

describe("Orchestrator integration", () => {
  test("completes a full mocked Claude -> tool -> result -> Claude loop", async () => {
    const tool = makeEchoTool("ECHO_TOOL");
    const brain = new ScriptedBrain([
      {
        text: "",
        toolCalls: [{ id: "call-1", toolName: "echo_tool", input: { hello: "world" } }],
        stopReason: "tool_use",
      },
      { text: "Done! The tool echoed your input.", toolCalls: [], stopReason: "end_turn" },
    ]);

    const { orchestrator, conversation, toolRegistry: _tr } = setup(brain, [tool]);
    const finalResponse = await orchestrator.handleUserMessage("user-1", "please echo hello world");

    expect(finalResponse).toBe("Done! The tool echoed your input.");

    const messages = conversation.getMessages();
    const toolResult = messages.find((m) => m.role === "tool");
    expect(toolResult).toBeDefined();
    expect(JSON.parse((toolResult as { content: string }).content)).toEqual({
      success: true,
      data: { hello: "world" },
    });
  });

  test("returns Claude's text directly when no tool call is requested", async () => {
    const brain = new ScriptedBrain([{ text: "Just chatting, no tools needed.", toolCalls: [], stopReason: "end_turn" }]);
    const { orchestrator } = setup(brain);

    const response = await orchestrator.handleUserMessage("user-1", "hi");
    expect(response).toBe("Just chatting, no tools needed.");
  });

  test("rejects execution of an unauthorized tool and reports it back to Claude", async () => {
    const dangerousTool = makeEchoTool("DANGEROUS_TOOL", PermissionLevel.DANGEROUS);
    const brain = new ScriptedBrain([
      {
        text: "",
        toolCalls: [{ id: "call-1", toolName: "dangerous_tool", input: {} }],
        stopReason: "tool_use",
      },
      { text: "I was not able to perform that action.", toolCalls: [], stopReason: "end_turn" },
    ]);

    const { orchestrator, conversation } = setup(brain, [dangerousTool]);
    const finalResponse = await orchestrator.handleUserMessage("user-1", "do something dangerous");

    expect(finalResponse).toBe("I was not able to perform that action.");

    const toolResult = conversation.getMessages().find((m) => m.role === "tool");
    const parsed = JSON.parse((toolResult as { content: string }).content);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/Permission denied/);
  });

  test("reports an unknown tool name back to Claude instead of throwing", async () => {
    const brain = new ScriptedBrain([
      {
        text: "",
        toolCalls: [{ id: "call-1", toolName: "does_not_exist", input: {} }],
        stopReason: "tool_use",
      },
      { text: "That tool is not available.", toolCalls: [], stopReason: "end_turn" },
    ]);

    const { orchestrator, conversation } = setup(brain);
    const finalResponse = await orchestrator.handleUserMessage("user-1", "call a made up tool");

    expect(finalResponse).toBe("That tool is not available.");
    const toolResult = conversation.getMessages().find((m) => m.role === "tool");
    const parsed = JSON.parse((toolResult as { content: string }).content);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/Unknown tool/);
  });
});
