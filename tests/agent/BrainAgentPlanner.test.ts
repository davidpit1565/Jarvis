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

/**
 * A Brain that also implements `chatWithEscalation` (AIRouter's Model
 * Escalation contract), so `BrainAgentPlanner`'s duck-typed
 * `supportsEscalation` check picks it up. Its own `chatWithEscalation`
 * mimics AIRouter's real semantics closely enough for these unit tests:
 * runs `chat()` once, and — only if the caller's `isValid` rejects the
 * result — returns the next queued "escalated" response instead.
 */
class EscalatingScriptedBrain implements Brain {
  requests: BrainRequest[] = [];
  escalationCalls = 0;
  constructor(
    private readonly firstResponse: BrainResponse,
    private readonly escalatedResponse: BrainResponse
  ) {}

  async chat(request: BrainRequest): Promise<BrainResponse> {
    this.requests.push(request);
    return this.firstResponse;
  }

  async chatWithEscalation(request: BrainRequest, isValid: (response: BrainResponse) => boolean): Promise<BrainResponse> {
    const first = await this.chat(request);
    if (isValid(first)) return first;
    this.escalationCalls++;
    return this.escalatedResponse;
  }
}

describe("BrainAgentPlanner.plan — Model Escalation", () => {
  test("escalates once when the first response doesn't parse into a JSON array, and uses the escalated plan", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.registerTool(makeReadTool("list_things"));
    const brain = new EscalatingScriptedBrain(
      { text: "sorry, I can't help with that", toolCalls: [], stopReason: "end_turn" },
      { text: '[{"toolName":"list_things","input":{},"description":"list them"}]', toolCalls: [], stopReason: "end_turn" }
    );

    const planner = new BrainAgentPlanner(brain, toolRegistry);
    const plan = await planner.plan({ goal: "list the things", userId: "user-1", completedSteps: [], taskId: "task-1" });

    expect(brain.escalationCalls).toBe(1);
    expect(plan).toEqual([{ toolName: "list_things", input: {}, description: "list them" }]);
  });

  test("does not escalate when the first response is already a legitimately-empty plan", async () => {
    const toolRegistry = new ToolRegistry();
    const brain = new EscalatingScriptedBrain(
      { text: "[]", toolCalls: [], stopReason: "end_turn" },
      { text: '[{"toolName":"should_not_be_used","input":{},"description":"x"}]', toolCalls: [], stopReason: "end_turn" }
    );

    const planner = new BrainAgentPlanner(brain, toolRegistry);
    const plan = await planner.plan({ goal: "impossible goal", userId: "user-1", completedSteps: [], taskId: "task-2" });

    expect(brain.escalationCalls).toBe(0);
    expect(plan).toEqual([]);
  });

  test("passes the task id through as runId, scoping Denial-of-wallet protection to this task", async () => {
    const toolRegistry = new ToolRegistry();
    const brain = new EscalatingScriptedBrain(
      { text: "[]", toolCalls: [], stopReason: "end_turn" },
      { text: "[]", toolCalls: [], stopReason: "end_turn" }
    );

    const planner = new BrainAgentPlanner(brain, toolRegistry);
    await planner.plan({ goal: "goal", userId: "user-1", completedSteps: [], taskId: "task-42" });

    expect(brain.requests[0]?.runId).toBe("task-42");
  });

  test("tags the plan request with taskType 'agent-plan', for CostTracker's per-task-type breakdown", async () => {
    const toolRegistry = new ToolRegistry();
    const brain = new EscalatingScriptedBrain(
      { text: "[]", toolCalls: [], stopReason: "end_turn" },
      { text: "[]", toolCalls: [], stopReason: "end_turn" }
    );

    const planner = new BrainAgentPlanner(brain, toolRegistry);
    await planner.plan({ goal: "goal", userId: "user-1", completedSteps: [], taskId: "task-42" });

    expect(brain.requests[0]?.taskType).toBe("agent-plan");
  });

  test("a plain Brain without chatWithEscalation still works exactly as before (no escalation attempted)", async () => {
    const toolRegistry = new ToolRegistry();
    const brain = new ScriptedBrain([{ text: "not valid json at all", toolCalls: [], stopReason: "end_turn" }]);

    const planner = new BrainAgentPlanner(brain, toolRegistry);
    const plan = await planner.plan({ goal: "goal", userId: "user-1", completedSteps: [], taskId: "task-3" });

    // No escalation capability on this Brain -> falls straight through to
    // extractJson, which fails to parse -> empty plan, same as before
    // Model Escalation existed.
    expect(plan).toEqual([]);
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

  test("still defines tools on the final-verdict call, since its messages carry tool_use/tool_result blocks", async () => {
    // Anthropic's real API rejects any request whose messages contain a
    // tool_use/tool_result block but whose `tools` array is empty — the
    // exact shape this second brain.chat() call in `verify()` builds after
    // running a verification tool call. This stub throws that real error
    // to prove the fix, rather than a mock that would silently accept
    // whatever shape verify() happens to send.
    class AnthropicShapeCheckingBrain implements Brain {
      private calls = 0;
      async chat(request: BrainRequest): Promise<BrainResponse> {
        this.calls++;
        if (this.calls === 1) {
          return { text: "", toolCalls: [{ id: "call-1", toolName: "check_thing", input: {} }], stopReason: "tool_use" };
        }
        const hasToolBlocks = request.messages.some((m) => ("toolCalls" in m && m.toolCalls) || m.role === "tool");
        if (hasToolBlocks && request.tools.length === 0) {
          throw new Error(
            "400 invalid_request_error: messages.1: `tool_use` ids were found without `tool_result` blocks immediately after: call-1. Each `tool_use` block must have a corresponding `tool_result` block in the next message, and `tools` must be defined."
          );
        }
        expect(request.tools.map((t) => t.name)).toEqual(["check_thing"]);
        return { text: '{"verified":true,"reason":"confirmed"}', toolCalls: [], stopReason: "end_turn" };
      }
    }

    const toolRegistry = new ToolRegistry();
    toolRegistry.registerTool(makeReadTool("check_thing"));
    const planner = new BrainAgentPlanner(new AnthropicShapeCheckingBrain(), toolRegistry);

    const result = await planner.verify({
      step: { id: "s1", description: "d", toolName: "create_thing", input: {}, status: "succeeded" },
      result: { success: true, data: {} },
      runVerificationTool: async () => ({ success: true }),
    });

    expect(result).toEqual({ verified: true, reason: "confirmed" });
  });
});
