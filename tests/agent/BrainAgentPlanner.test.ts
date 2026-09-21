import { describe, test, expect } from "bun:test";
import { BrainAgentPlanner } from "@/agent/BrainAgentPlanner";
import { ToolRegistry } from "@/tools/registry/ToolRegistry";
import { PermissionLevel } from "@/types/permissions";
import type { Brain, BrainRequest, BrainResponse } from "@/types/brain";
import type { LocalTool } from "@/types/tools";

function makeReadTool(name: string): LocalTool {
  return {
    id: name.toUpperCase(),
    name,
    description: "a read-only test tool",
    inputSchema: { type: "object", properties: {} },
    requiredPermission: PermissionLevel.READ,
    target: "local",
    execute: async () => ({ success: true, data: {} }),
  };
}

/** A Brain that returns queued responses in order — no network calls. */
class ScriptedBrain implements Brain {
  private calls = 0;
  requests: BrainRequest[] = [];
  constructor(private readonly responses: BrainResponse[]) {}

  async chat(request: BrainRequest): Promise<BrainResponse> {
    this.requests.push(request);
    const response = this.responses[this.calls];
    this.calls++;
    if (!response) throw new Error("ScriptedBrain ran out of responses");
    return response;
  }
}

describe("BrainAgentPlanner.plan", () => {
  test("parses a clean JSON array of steps", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.registerTool(makeReadTool("list_things"));
    const brain = new ScriptedBrain([
      {
        text: '[{"toolName":"list_things","input":{},"description":"list them"}]',
        toolCalls: [],
        stopReason: "end_turn",
      },
    ]);

    const planner = new BrainAgentPlanner(brain, toolRegistry);
    const plan = await planner.plan({ goal: "list the things", userId: "user-1", completedSteps: [] });

    expect(plan).toEqual([{ toolName: "list_things", input: {}, description: "list them" }]);
  });

  test("extracts JSON even when the model wraps it in prose or a code fence", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.registerTool(makeReadTool("list_things"));
    const brain = new ScriptedBrain([
      {
        text: 'Sure, here is the plan:\n```json\n[{"toolName":"list_things","input":{},"description":"list them"}]\n```',
        toolCalls: [],
        stopReason: "end_turn",
      },
    ]);

    const planner = new BrainAgentPlanner(brain, toolRegistry);
    const plan = await planner.plan({ goal: "list the things", userId: "user-1", completedSteps: [] });

    expect(plan).toHaveLength(1);
    expect(plan[0]?.toolName).toBe("list_things");
  });

  test("returns an empty plan when the model returns unparseable text", async () => {
    const toolRegistry = new ToolRegistry();
    const brain = new ScriptedBrain([{ text: "I cannot help with that.", toolCalls: [], stopReason: "end_turn" }]);

    const planner = new BrainAgentPlanner(brain, toolRegistry);
    const plan = await planner.plan({ goal: "impossible goal", userId: "user-1", completedSteps: [] });

    expect(plan).toEqual([]);
  });

  test("filters out malformed step entries instead of throwing", async () => {
    const toolRegistry = new ToolRegistry();
    const brain = new ScriptedBrain([
      {
        text: '[{"toolName":"ok_tool","input":{},"description":"fine"},{"missingFields":true}]',
        toolCalls: [],
        stopReason: "end_turn",
      },
    ]);

    const planner = new BrainAgentPlanner(brain, toolRegistry);
    const plan = await planner.plan({ goal: "goal", userId: "user-1", completedSteps: [] });

    expect(plan).toEqual([{ toolName: "ok_tool", input: {}, description: "fine" }]);
  });

  test("includes prior failure context in the prompt for a recovery replan", async () => {
    const toolRegistry = new ToolRegistry();
    const brain = new ScriptedBrain([{ text: "[]", toolCalls: [], stopReason: "end_turn" }]);
    const planner = new BrainAgentPlanner(brain, toolRegistry);

    await planner.plan({ goal: "goal", userId: "user-1", priorFailure: "tool X errored", completedSteps: [] });

    const [request] = brain.requests;
    const userMessage = request?.messages.find((m) => m.role === "user");
    expect(userMessage && "content" in userMessage ? userMessage.content : "").toContain("tool X errored");
  });
});

describe("BrainAgentPlanner.verify", () => {
  test("parses a direct JSON verdict with no tool call", async () => {
    const toolRegistry = new ToolRegistry();
    const brain = new ScriptedBrain([{ text: '{"verified":true,"reason":"looks right"}', toolCalls: [], stopReason: "end_turn" }]);
    const planner = new BrainAgentPlanner(brain, toolRegistry);

    const result = await planner.verify({
      step: { id: "s1", description: "d", toolName: "t", input: {}, status: "succeeded" },
      result: { success: true, data: {} },
      runVerificationTool: async () => ({ success: true }),
    });

    expect(result).toEqual({ verified: true, reason: "looks right" });
  });

  test("runs a follow-up verification tool call and asks for a final verdict", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.registerTool(makeReadTool("check_thing"));
    const brain = new ScriptedBrain([
      { text: "", toolCalls: [{ id: "call-1", toolName: "check_thing", input: {} }], stopReason: "tool_use" },
      { text: '{"verified":false,"reason":"not found"}', toolCalls: [], stopReason: "end_turn" },
    ]);
    const planner = new BrainAgentPlanner(brain, toolRegistry);

    let verificationToolCalled = false;
    const result = await planner.verify({
      step: { id: "s1", description: "d", toolName: "create_thing", input: {}, status: "succeeded" },
      result: { success: true, data: {} },
      runVerificationTool: async (toolName) => {
        verificationToolCalled = true;
        expect(toolName).toBe("check_thing");
        return { success: false, error: "not found" };
      },
    });

    expect(verificationToolCalled).toBe(true);
    expect(result).toEqual({ verified: false, reason: "not found" });
  });

  test("fails closed (not verified) when the verdict can't be parsed", async () => {
    const toolRegistry = new ToolRegistry();
    const brain = new ScriptedBrain([{ text: "unclear response", toolCalls: [], stopReason: "end_turn" }]);
    const planner = new BrainAgentPlanner(brain, toolRegistry);

    const result = await planner.verify({
      step: { id: "s1", description: "d", toolName: "t", input: {}, status: "succeeded" },
      result: { success: true },
      runVerificationTool: async () => ({ success: true }),
    });

    expect(result.verified).toBe(false);
  });
});
