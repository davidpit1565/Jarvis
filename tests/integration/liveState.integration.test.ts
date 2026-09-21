import { describe, test, expect } from "bun:test";
import { Orchestrator } from "@/core/orchestrator/Orchestrator";
import { ConversationManager } from "@/core/conversation/ConversationManager";
import { EventBus } from "@/core/events/EventBus";
import { ToolRegistry } from "@/tools/registry/ToolRegistry";
import { PermissionService } from "@/permissions/PermissionService";
import { PermissionLevel } from "@/types/permissions";
import { AgentCore } from "@/agent/AgentCore";
import { AgentTaskStore } from "@/agent/AgentTaskStore";
import { ToolAuditLog } from "@/audit/ToolAuditLog";
import { JarvisLiveStateTracker } from "@/core/state/JarvisLiveState";
import type { Brain, BrainRequest, BrainResponse } from "@/types/brain";
import type { LocalTool, ToolResult } from "@/types/tools";
import type { AgentPlanRequest, AgentPlanner, AgentStepProposal, AgentVerificationRequest, AgentVerificationResult } from "@/agent/types";

/** Scripted mock brain: returns queued responses in order, one per call. */
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

function makeTool(
  name: string,
  execute: LocalTool["execute"],
  requiredPermission = PermissionLevel.READ,
  requiresVerification?: boolean
): LocalTool {
  return {
    id: name.toUpperCase(),
    name,
    description: "test tool",
    inputSchema: { type: "object", properties: {} },
    requiredPermission,
    target: "local",
    execute,
    requiresVerification,
  };
}

describe("JarvisLiveState wired into Orchestrator.handleUserMessage", () => {
  function setup(brain: Brain, tools: LocalTool[] = []) {
    const eventBus = new EventBus();
    const toolRegistry = new ToolRegistry();
    for (const tool of tools) toolRegistry.registerTool(tool);
    const permissionService = new PermissionService();
    const conversation = new ConversationManager(eventBus);
    const liveState = new JarvisLiveStateTracker(eventBus);

    const orchestrator = new Orchestrator({
      brain,
      conversation,
      toolRegistry,
      permissionService,
      eventBus,
      liveState,
    });
    return { orchestrator, liveState, eventBus };
  }

  test("a plain text-only turn walks LISTENING -> THINKING -> SPEAKING -> IDLE", async () => {
    const brain = new ScriptedBrain([{ text: "hi there", toolCalls: [], stopReason: "end_turn" }]);
    const { orchestrator, liveState, eventBus } = setup(brain);

    const seen: Array<{ from: string; to: string }> = [];
    eventBus.on("jarvis.liveState.changed", (payload) => {
      if (payload.sessionId === "chat:user-1") seen.push({ from: payload.from, to: payload.to });
    });

    expect(liveState.getState("chat:user-1")).toBe("IDLE");
    const reply = await orchestrator.handleUserMessage("user-1", "hello");
    expect(reply).toBe("hi there");

    // Ends back at IDLE — the reset() after SPEAKING.
    expect(liveState.getState("chat:user-1")).toBe("IDLE");
    expect(seen.map((s) => s.to)).toEqual(["LISTENING", "THINKING", "SPEAKING", "IDLE"]);
  });

  test("a turn with a tool call walks through EXECUTING and back to THINKING before SPEAKING", async () => {
    const tool = makeTool("echo", async (input) => ({ success: true, data: input }));
    const brain = new ScriptedBrain([
      {
        text: "",
        toolCalls: [{ id: "call-1", toolName: "echo", input: {} }],
        stopReason: "tool_use",
      },
      { text: "done", toolCalls: [], stopReason: "end_turn" },
    ]);
    const { orchestrator, liveState, eventBus } = setup(brain, [tool]);

    const seen: string[] = [];
    eventBus.on("jarvis.liveState.changed", (payload) => {
      if (payload.sessionId === "chat:user-1") seen.push(payload.to);
    });

    const reply = await orchestrator.handleUserMessage("user-1", "run the tool");
    expect(reply).toBe("done");
    expect(seen).toEqual(["LISTENING", "THINKING", "EXECUTING", "THINKING", "SPEAKING", "IDLE"]);
  });

  test("an uncaught error mid-turn transitions to ERROR and settles back to IDLE", async () => {
    const failingBrain: Brain = {
      async chat(): Promise<BrainResponse> {
        throw new Error("brain exploded");
      },
    };
    const { orchestrator, liveState, eventBus } = setup(failingBrain);

    const seen: string[] = [];
    eventBus.on("jarvis.liveState.changed", (payload) => {
      if (payload.sessionId === "chat:user-1") seen.push(payload.to);
    });

    await expect(orchestrator.handleUserMessage("user-1", "hello")).rejects.toThrow("brain exploded");
    expect(seen).toEqual(["LISTENING", "THINKING", "ERROR", "IDLE"]);
    expect(liveState.getState("chat:user-1")).toBe("IDLE");
  });

  test("requestStop interrupts before the next tool call, and the turn returns early", async () => {
    let stopRequestedDuringTool = false;
    const tool = makeTool("slow", async (input) => {
      stopRequestedDuringTool = true;
      return { success: true, data: input };
    });
    const brain = new ScriptedBrain([
      { text: "", toolCalls: [{ id: "c1", toolName: "slow", input: {} }], stopReason: "tool_use" },
      // Second scripted response should never be reached — the loop must
      // return "Stopped." after the stop request instead of calling brain
      // again.
      { text: "should not get here", toolCalls: [], stopReason: "end_turn" },
    ]);
    const { orchestrator, liveState } = setup(brain, [tool]);

    // Request the stop immediately, before the turn even starts running —
    // handleUserMessage's own reset() at the top would normally clear a
    // stale stop request, so instead we request it once the turn is
    // already LISTENING by racing it in after a microtask tick below.
    const turnPromise = orchestrator.handleUserMessage("user-1", "go slow");
    // Give the LISTENING/THINKING transitions a tick, then request stop
    // before the tool call actually resolves.
    queueMicrotask(() => orchestrator.requestStop("user-1"));

    const reply = await turnPromise;
    expect(reply).toBe("Stopped.");
    expect(liveState.getState("chat:user-1")).toBe("STOPPED");
  });
});

describe("JarvisLiveState wired into AgentCore.runTask", () => {
  class ScriptedPlanner implements AgentPlanner {
    private planCalls = 0;
    constructor(
      private readonly plans: AgentStepProposal[][],
      private readonly verdicts: AgentVerificationResult[] = []
    ) {}
    async plan(_request: AgentPlanRequest): Promise<AgentStepProposal[]> {
      const plan = this.plans[this.planCalls];
      this.planCalls++;
      return plan ?? [];
    }
    async verify(_request: AgentVerificationRequest): Promise<AgentVerificationResult> {
      return this.verdicts[0] ?? { verified: true, reason: "ok" };
    }
  }

  function setupAgent(planner: AgentPlanner, tools: LocalTool[] = []) {
    const eventBus = new EventBus();
    const toolRegistry = new ToolRegistry();
    for (const tool of tools) toolRegistry.registerTool(tool);
    const permissionService = new PermissionService();
    const conversation = new ConversationManager(eventBus);
    const liveState = new JarvisLiveStateTracker(eventBus);
    const auditLog = new ToolAuditLog();
    const taskStore = new AgentTaskStore();

    const unusedBrain: Brain = {
      async chat(): Promise<BrainResponse> {
        throw new Error("Brain.chat should never be invoked by AgentCore's step-execution path");
      },
    };

    const orchestrator = new Orchestrator({
      brain: unusedBrain,
      conversation,
      toolRegistry,
      permissionService,
      eventBus,
    });

    const agentCore = new AgentCore({
      orchestrator,
      planner,
      toolRegistry,
      taskStore,
      auditLog,
      eventBus,
      liveState,
    });

    return { agentCore, liveState, eventBus };
  }

  test("a successful task walks PLANNING -> EXECUTING -> VERIFYING -> SPEAKING -> IDLE on the agent: session", async () => {
    const tool = makeTool("do-it", async (input) => ({ success: true, data: input }), PermissionLevel.READ, true);
    const planner = new ScriptedPlanner([[{ description: "do it", toolName: "do-it", input: {} }]]);
    const { agentCore, liveState, eventBus } = setupAgent(planner, [tool]);

    const seen: string[] = [];
    eventBus.on("jarvis.liveState.changed", (payload) => {
      if (payload.sessionId === "agent:user-1") seen.push(payload.to);
    });

    const task = await agentCore.runTask("user-1", "do it");
    expect(task.state).toBe("COMPLETED");
    // PLANNING -> EXECUTING -> VERIFYING -> EXECUTING (verified; continuing
    // plan, then the loop finds no more steps) -> SPEAKING -> IDLE.
    expect(seen).toEqual(["PLANNING", "EXECUTING", "VERIFYING", "EXECUTING", "SPEAKING", "IDLE"]);
    expect(liveState.getState("agent:user-1")).toBe("IDLE");
  });

  test("a failed task transitions to ERROR and settles back to IDLE", async () => {
    const planner = new ScriptedPlanner([]); // empty plan -> immediate failure
    const { agentCore, liveState, eventBus } = setupAgent(planner);

    const seen: string[] = [];
    eventBus.on("jarvis.liveState.changed", (payload) => {
      if (payload.sessionId === "agent:user-1") seen.push(payload.to);
    });

    const task = await agentCore.runTask("user-1", "impossible");
    expect(task.state).toBe("FAILED");
    expect(seen).toEqual(["PLANNING", "ERROR", "IDLE"]);
  });

  test("a chat session and an agent-task session for the same userId are isolated", async () => {
    const tool = makeTool("do-it", async (input) => ({ success: true, data: input }));
    const planner = new ScriptedPlanner([[{ description: "do it", toolName: "do-it", input: {} }]]);
    const { agentCore, liveState } = setupAgent(planner, [tool]);

    // Simulate a concurrent plain chat turn for the same user on the
    // "chat:" channel, driven directly against the same tracker.
    liveState.transition("chat:user-1", "user-1", "LISTENING");

    await agentCore.runTask("user-1", "do it");

    // The agent task's own completion must not have touched the
    // independent chat session.
    expect(liveState.getState("chat:user-1")).toBe("LISTENING");
    expect(liveState.getState("agent:user-1")).toBe("IDLE");
  });
});
