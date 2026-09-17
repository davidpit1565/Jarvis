import { describe, test, expect } from "bun:test";
import { Orchestrator } from "@/core/orchestrator/Orchestrator";
import { ConversationManager } from "@/core/conversation/ConversationManager";
import { EventBus } from "@/core/events/EventBus";
import { ToolRegistry } from "@/tools/registry/ToolRegistry";
import { PermissionService } from "@/permissions/PermissionService";
import { PermissionLevel } from "@/types/permissions";
import { ConfirmationService, type ConfirmationRequest } from "@/core/confirmation/ConfirmationService";
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

function makeConfirmTool(requiredPermission: LocalTool["requiredPermission"] = PermissionLevel.DANGEROUS): LocalTool {
  return {
    id: "DELETE_EVERYTHING",
    name: "delete_everything",
    description: "A dangerous test tool",
    inputSchema: { type: "object", properties: {} },
    requiredPermission,
    target: "local",
    execute: async () => ({ success: true, data: "deleted" }),
  };
}

function setup(brain: Brain, confirmationService?: ConfirmationService, granted = true) {
  const eventBus = new EventBus();
  const toolRegistry = new ToolRegistry();
  const tool = makeConfirmTool();
  toolRegistry.registerTool(tool);
  const permissionService = new PermissionService();
  if (granted) permissionService.grant("user-1", tool.id);
  const conversation = new ConversationManager(eventBus);

  const orchestrator = new Orchestrator({
    brain,
    conversation,
    toolRegistry,
    permissionService,
    eventBus,
    confirmationService,
  });
  return { orchestrator, conversation };
}

function toolCallResponses(): BrainResponse[] {
  return [
    { text: "", toolCalls: [{ id: "call-1", toolName: "delete_everything", input: {} }], stopReason: "tool_use" },
    { text: "Done.", toolCalls: [], stopReason: "end_turn" },
  ];
}

describe("Confirmation flow", () => {
  test("a DANGEROUS tool runs after the human approves", async () => {
    const confirmationService = new ConfirmationService(async () => true);
    const { orchestrator, conversation } = setup(new ScriptedBrain(toolCallResponses()), confirmationService);

    const response = await orchestrator.handleUserMessage("user-1", "delete everything");

    expect(response).toBe("Done.");
    const toolResult = conversation.getMessages().find((m) => m.role === "tool");
    expect(JSON.parse((toolResult as { content: string }).content)).toEqual({ success: true, data: "deleted" });
  });

  test("a DANGEROUS tool is blocked when the human declines", async () => {
    const confirmationService = new ConfirmationService(async () => false);
    const { orchestrator, conversation } = setup(new ScriptedBrain(toolCallResponses()), confirmationService);

    await orchestrator.handleUserMessage("user-1", "delete everything");

    const toolResult = conversation.getMessages().find((m) => m.role === "tool");
    const parsed = JSON.parse((toolResult as { content: string }).content);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/declined/i);
  });

  test("the confirmation prompter receives the tool and input being confirmed", async () => {
    let received: ConfirmationRequest | null = null;
    const confirmationService = new ConfirmationService(async (request) => {
      received = request;
      return true;
    });
    const { orchestrator } = setup(new ScriptedBrain(toolCallResponses()), confirmationService);

    await orchestrator.handleUserMessage("user-1", "delete everything");

    expect(received).not.toBeNull();
    expect((received as unknown as ConfirmationRequest).toolId).toBe("DELETE_EVERYTHING");
    expect((received as unknown as ConfirmationRequest).userId).toBe("user-1");
  });

  test("a DANGEROUS tool is denied outright with no grant, never reaching confirmation", async () => {
    let promptCalled = false;
    const confirmationService = new ConfirmationService(async () => {
      promptCalled = true;
      return true;
    });
    const { orchestrator, conversation } = setup(new ScriptedBrain(toolCallResponses()), confirmationService, false);

    await orchestrator.handleUserMessage("user-1", "delete everything");

    expect(promptCalled).toBe(false);
    const toolResult = conversation.getMessages().find((m) => m.role === "tool");
    const parsed = JSON.parse((toolResult as { content: string }).content);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/Permission denied/);
  });

  test("a DANGEROUS tool with a grant but no confirmationService configured is denied safely", async () => {
    const { orchestrator, conversation } = setup(new ScriptedBrain(toolCallResponses()), undefined, true);

    await orchestrator.handleUserMessage("user-1", "delete everything");

    const toolResult = conversation.getMessages().find((m) => m.role === "tool");
    const parsed = JSON.parse((toolResult as { content: string }).content);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/confirmation/i);
  });
});
