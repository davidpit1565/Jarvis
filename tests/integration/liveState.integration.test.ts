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
    return { orchestrator, liveState, eventBus, conversation };
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

  describe("status-query fast path (\"what are you doing?\")", () => {
    test("answers a literal status query directly from the current snapshot, with no brain call at all", async () => {
      const brain = new ScriptedBrain([]); // would throw if ever called — proves the brain is never reached
      const { orchestrator, liveState, eventBus } = setup(brain);
      liveState.transition("chat:user-1", "user-1", "LISTENING");
      liveState.transition("chat:user-1", "user-1", "THINKING", { reason: "awaiting brain response" });

      const events: Array<{ userId: string; sessionId: string; state: string }> = [];
      eventBus.on("fastPath.statusQuery", (payload) => events.push(payload));

      const reply = await orchestrator.handleUserMessage("user-1", "what are you doing?");

      expect(reply).toBe("I'm thinking about how to respond.");
      expect(events).toEqual([{ userId: "user-1", sessionId: "chat:user-1", state: "THINKING" }]);
      // The live state this query observed must be left exactly as it was
      // found — a status read must never itself perturb the state machine.
      expect(liveState.getState("chat:user-1")).toBe("THINKING");
    });

    test("a status query in Hebrew is answered in Hebrew", async () => {
      const brain = new ScriptedBrain([]);
      const { orchestrator, liveState } = setup(brain);
      liveState.transition("chat:user-1", "user-1", "LISTENING", { language: "he" });

      const reply = await orchestrator.handleUserMessage("user-1", "מה אתה עושה?");

      expect(reply).toBe("אני מקשיב להודעה שלך.");
    });

    test("an idle session gets an honest \"not doing anything\" reply, never a fabricated status", async () => {
      const brain = new ScriptedBrain([]);
      const { orchestrator } = setup(brain);

      const reply = await orchestrator.handleUserMessage("user-1", "what are you doing right now");

      expect(reply).toBe("I'm not doing anything right now — just waiting for you.");
    });

    test("with no liveState tracker configured at all, still answers honestly as idle instead of erroring", async () => {
      const eventBus = new EventBus();
      const toolRegistry = new ToolRegistry();
      const permissionService = new PermissionService();
      const conversation = new ConversationManager(eventBus);
      const brain = new ScriptedBrain([]);
      const orchestrator = new Orchestrator({ brain, conversation, toolRegistry, permissionService, eventBus }); // no liveState

      const reply = await orchestrator.handleUserMessage("user-1", "what are you doing?");

      expect(reply).toBe("I'm not doing anything right now — just waiting for you.");
    });

    test("the exchange is still recorded into conversation history", async () => {
      const brain = new ScriptedBrain([]);
      const { orchestrator, conversation } = setup(brain);

      await orchestrator.handleUserMessage("user-1", "what are you doing?");

      const messages = conversation.getMessages();
      expect(messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
      expect((messages[0] as { content: string }).content).toBe("what are you doing?");
    });

    test("a status query reads whatever is CURRENTLY live for the session, not a stale value", async () => {
      // A shared tracker with something genuinely in flight on this user's
      // "agent:" live session (as a real AgentCore task would drive it —
      // see the "wired into AgentCore.runTask" describe block below for
      // that full wiring), queried by a second Orchestrator instance bound
      // to that same channel, simulating a UI that already knows which
      // session id to ask about.
      const sharedEventBus = new EventBus();
      const liveState = new JarvisLiveStateTracker(sharedEventBus);
      liveState.transition("agent:user-1", "user-1", "PLANNING");
      liveState.transition("agent:user-1", "user-1", "EXECUTING", { reason: "agent task t1: plan ready" });

      const eventBus = new EventBus();
      const toolRegistry = new ToolRegistry();
      const permissionService = new PermissionService();
      const conversation = new ConversationManager(eventBus);
      const brain = new ScriptedBrain([]);
      const orchestrator = new Orchestrator({
        brain,
        conversation,
        toolRegistry,
        permissionService,
        eventBus,
        liveState,
        liveStateChannel: "agent",
      });

      const reply = await orchestrator.handleUserMessage("user-1", "what are you doing?");
      expect(reply).toContain("actively working on it");
    });
  });

  describe("why-query fast path (\"why did you do that?\")", () => {
    test("explains the most recent tool call from real conversation history, with no brain call at all", async () => {
      const tool = makeTool("list_calendar_events", async () => ({ success: true, data: [] }));
      const brain = new ScriptedBrain([
        { text: "", toolCalls: [{ id: "c1", toolName: "list_calendar_events", input: {} }], stopReason: "tool_use" },
        { text: "Nothing on your calendar.", toolCalls: [], stopReason: "end_turn" },
      ]);
      const { orchestrator } = setup(brain, [tool]);

      await orchestrator.handleUserMessage("user-1", "prepare tomorrow");

      // A second scripted brain would throw if reached — proves this
      // second turn never touches the brain either.
      const reply = await orchestrator.handleUserMessage("user-1", "why did you do that?");

      expect(reply).toBe('You asked me to "prepare tomorrow", so I used list calendar events to help with that.');
    });

    test("emits fastPath.whyQuery with the real tool name", async () => {
      const tool = makeTool("get_weather", async () => ({ success: true, data: {} }));
      const brain = new ScriptedBrain([
        { text: "", toolCalls: [{ id: "c1", toolName: "get_weather", input: {} }], stopReason: "tool_use" },
        { text: "It's sunny.", toolCalls: [], stopReason: "end_turn" },
      ]);
      const { orchestrator, eventBus } = setup(brain, [tool]);

      const events: Array<{ userId: string; sessionId: string; toolName?: string }> = [];
      eventBus.on("fastPath.whyQuery", (payload) => events.push(payload));

      await orchestrator.handleUserMessage("user-1", "what's the weather");
      await orchestrator.handleUserMessage("user-1", "why did you check the weather");

      expect(events).toEqual([{ userId: "user-1", sessionId: "chat:user-1", toolName: "get_weather" }]);
    });

    test("an honest 'nothing to explain yet' reply when no tool call has happened in this conversation", async () => {
      const brain = new ScriptedBrain([]); // never reached
      const { orchestrator } = setup(brain);

      const reply = await orchestrator.handleUserMessage("user-1", "why did you do that?");

      expect(reply).toBe("I haven't done anything to explain yet.");
    });

    test("a why-query in Hebrew is answered in Hebrew", async () => {
      const tool = makeTool("get_weather", async () => ({ success: true, data: {} }));
      const brain = new ScriptedBrain([
        { text: "", toolCalls: [{ id: "c1", toolName: "get_weather", input: {} }], stopReason: "tool_use" },
        { text: "שמש.", toolCalls: [], stopReason: "end_turn" },
      ]);
      const { orchestrator, liveState } = setup(brain, [tool]);
      liveState.transition("chat:user-1", "user-1", "LISTENING", { language: "he" });

      await orchestrator.handleUserMessage("user-1", "מה מזג האוויר");
      const reply = await orchestrator.handleUserMessage("user-1", "למה בדקת את מזג האוויר");

      expect(reply).toContain("get weather");
      expect(reply).toContain("ביקשת ממני");
    });

    test("the exchange is still recorded into conversation history", async () => {
      const brain = new ScriptedBrain([]);
      const { orchestrator, conversation } = setup(brain);

      await orchestrator.handleUserMessage("user-1", "why did you do that?");

      const messages = conversation.getMessages();
      expect(messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
    });
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
