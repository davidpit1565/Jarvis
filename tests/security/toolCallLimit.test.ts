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

function makeCountingTool(): { tool: LocalTool; callCount: () => number } {
  let count = 0;
  const tool: LocalTool = {
    id: "COUNTING_TOOL",
    name: "counting_tool",
    description: "Counts how many times it actually ran",
    inputSchema: { type: "object", properties: {} },
    requiredPermission: PermissionLevel.READ,
    target: "local",
    execute: async () => {
      count++;
      return { success: true, data: { count } };
    },
  };
  return { tool, callCount: () => count };
}

describe("Tool Risk Model: per-run tool-call cap (Orchestrator)", () => {
  test("a single brain response requesting more tool calls than the global cap only executes up to the cap", async () => {
    const { tool, callCount } = makeCountingTool();
    // A single brain "turn" with far more tool calls than any real
    // conversation should ever need — simulating a malfunctioning or
    // adversarial model response trying to run an unbounded loop.
    const manyToolCalls = Array.from({ length: 10 }, (_, i) => ({
      id: `call-${i}`,
      toolName: "counting_tool",
      input: {},
    }));

    const brain = new ScriptedBrain([
      { text: "", toolCalls: manyToolCalls, stopReason: "tool_use" },
      { text: "done", toolCalls: [], stopReason: "end_turn" },
    ]);

    const eventBus = new EventBus();
    const toolRegistry = new ToolRegistry();
    toolRegistry.registerTool(tool);
    const permissionService = new PermissionService();
    const conversation = new ConversationManager(eventBus);

    let limitExceededEvents = 0;
    eventBus.on("tool.callLimitExceeded", () => {
      limitExceededEvents++;
    });

    const orchestrator = new Orchestrator({
      brain,
      conversation,
      toolRegistry,
      permissionService,
      eventBus,
      maxToolCallsPerRun: 3,
    });

    await orchestrator.handleUserMessage("user-1", "run the counting tool a bunch of times");

    // Only the first 3 of the 10 requested calls actually ran.
    expect(callCount()).toBe(3);
    expect(limitExceededEvents).toBe(7);
  });

  test("calls beyond the cap get an error ToolResult, not a thrown exception or a hang", async () => {
    const { tool } = makeCountingTool();
    const manyToolCalls = Array.from({ length: 4 }, (_, i) => ({
      id: `call-${i}`,
      toolName: "counting_tool",
      input: {},
    }));

    const brain = new ScriptedBrain([
      { text: "", toolCalls: manyToolCalls, stopReason: "tool_use" },
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
      maxToolCallsPerRun: 2,
    });

    const response = await orchestrator.handleUserMessage("user-1", "go");
    expect(response).toBe("done");

    const toolResults = conversation
      .getMessages()
      .filter((m) => m.role === "tool") as Array<{ content: string }>;
    expect(toolResults).toHaveLength(4);

    const parsedResults = toolResults.map(
      (r) => parseQuarantinedToolResult(r.content) as { success: boolean; error?: string }
    );
    expect(parsedResults.filter((r) => r.success)).toHaveLength(2);
    expect(parsedResults.filter((r) => !r.success)).toHaveLength(2);
    expect(parsedResults.find((r) => !r.success)?.error).toMatch(/Exceeded the maximum/);
  });

  test("a per-tool maxCallsPerRun caps that tool tighter than the global default", async () => {
    const { tool, callCount } = makeCountingTool();
    const restrictedTool: LocalTool = { ...tool, maxCallsPerRun: 1 };

    const brain = new ScriptedBrain([
      {
        text: "",
        toolCalls: [
          { id: "call-1", toolName: "counting_tool", input: {} },
          { id: "call-2", toolName: "counting_tool", input: {} },
        ],
        stopReason: "tool_use",
      },
      { text: "done", toolCalls: [], stopReason: "end_turn" },
    ]);

    const eventBus = new EventBus();
    const toolRegistry = new ToolRegistry();
    toolRegistry.registerTool(restrictedTool);
    const permissionService = new PermissionService();
    const conversation = new ConversationManager(eventBus);

    const orchestrator = new Orchestrator({
      brain,
      conversation,
      toolRegistry,
      permissionService,
      eventBus,
      maxToolCallsPerRun: 30, // global cap is generous; the per-tool cap should still bite
    });

    await orchestrator.handleUserMessage("user-1", "go");
    expect(callCount()).toBe(1);
  });

  test("with no explicit maxToolCallsPerRun, a reasonable number of tool calls all still run (default isn't overly strict)", async () => {
    const { tool, callCount } = makeCountingTool();
    const someToolCalls = Array.from({ length: 5 }, (_, i) => ({
      id: `call-${i}`,
      toolName: "counting_tool",
      input: {},
    }));

    const brain = new ScriptedBrain([
      { text: "", toolCalls: someToolCalls, stopReason: "tool_use" },
      { text: "done", toolCalls: [], stopReason: "end_turn" },
    ]);

    const eventBus = new EventBus();
    const toolRegistry = new ToolRegistry();
    toolRegistry.registerTool(tool);
    const permissionService = new PermissionService();
    const conversation = new ConversationManager(eventBus);

    const orchestrator = new Orchestrator({ brain, conversation, toolRegistry, permissionService, eventBus });

    await orchestrator.handleUserMessage("user-1", "go");
    expect(callCount()).toBe(5);
  });
});
