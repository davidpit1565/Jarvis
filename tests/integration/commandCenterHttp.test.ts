import { describe, test, expect, afterEach } from "bun:test";
import { EventBus } from "@/core/events/EventBus";
import { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import { PairingService } from "@/devices/pairing/PairingService";
import { DeviceConnectionManager } from "@/communication/websocket/DeviceConnectionManager";
import { JarvisWebSocketServer, type JarvisWebSocketServerDependencies } from "@/communication/websocket/JarvisWebSocketServer";
import { MemoryStore } from "@/memory/MemoryStore";
import { AutomationRuleStore } from "@/automation/AutomationRuleStore";
import { CostTracker } from "@/core/cost/CostTracker";
import { JarvisLiveStateTracker } from "@/core/state/JarvisLiveState";
import { ToolAuditLog } from "@/audit/ToolAuditLog";
import { Orchestrator } from "@/core/orchestrator/Orchestrator";
import { ConversationManager } from "@/core/conversation/ConversationManager";
import { ToolRegistry } from "@/tools/registry/ToolRegistry";
import { PermissionService } from "@/permissions/PermissionService";
import type { Brain, BrainRequest, BrainResponse } from "@/types/brain";

/** Scripted mock brain: returns queued responses in order, one per call, and stalls forever after that (used to leave a session in an active live state so Stop has something to interrupt). */
class ScriptedBrain implements Brain {
  private calls = 0;
  constructor(private readonly responses: BrainResponse[]) {}
  async chat(_request: BrainRequest): Promise<BrainResponse> {
    const response = this.responses[this.calls];
    this.calls++;
    if (!response) return new Promise<BrainResponse>(() => {}); // never resolves — leaves the turn "in flight"
    return response;
  }
}

function setupServer(deps: Partial<JarvisWebSocketServerDependencies> = {}) {
  const eventBus = new EventBus();
  const server = new JarvisWebSocketServer({
    deviceRegistry: new DeviceRegistry(),
    deviceConnectionManager: new DeviceConnectionManager(eventBus),
    pairingService: new PairingService(),
    eventBus,
    ...deps,
  });
  const handle = server.start(0);
  return { handle, port: handle.port, eventBus };
}

describe("GET /memory (search)", () => {
  let activeHandle: { stop: () => void } | undefined;
  afterEach(() => {
    activeHandle?.stop();
    activeHandle = undefined;
  });

  test("404s when no MemoryStore is configured", async () => {
    const { handle, port } = setupServer();
    activeHandle = handle;
    const response = await fetch(`http://localhost:${port}/memory`);
    expect(response.status).toBe(404);
  });

  test("with no ?q= returns every record, same as before the query param existed", async () => {
    const memoryStore = new MemoryStore();
    memoryStore.save({ key: "timezone", value: "America/New_York" });
    memoryStore.save({ key: "favorite_color", value: "blue" });
    const { handle, port } = setupServer({ memoryStore });
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/memory`);
    const body = (await response.json()) as { memory: Array<{ key: string }> };
    expect(response.status).toBe(200);
    expect(body.memory.length).toBe(2);
  });

  test("?q= filters via MemoryStore.search()", async () => {
    const memoryStore = new MemoryStore();
    memoryStore.save({ key: "timezone", value: "America/New_York" });
    memoryStore.save({ key: "favorite_color", value: "blue" });
    const { handle, port } = setupServer({ memoryStore });
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/memory?q=timezone`);
    const body = (await response.json()) as { memory: Array<{ key: string }> };
    expect(response.status).toBe(200);
    expect(body.memory.length).toBe(1);
    expect(body.memory[0]!.key).toBe("timezone");
  });
});

describe("GET /automations", () => {
  let activeHandle: { stop: () => void } | undefined;
  afterEach(() => {
    activeHandle?.stop();
    activeHandle = undefined;
  });

  test("404s when no AutomationRuleStore is configured", async () => {
    const { handle, port } = setupServer();
    activeHandle = handle;
    const response = await fetch(`http://localhost:${port}/automations`);
    expect(response.status).toBe(404);
  });

  test("lists every stored rule", async () => {
    const store = new AutomationRuleStore();
    store.create({ timeOfDay: "08:00", instruction: "check the weather" });
    store.create({ timeOfDay: "18:00", instruction: "summarize today" });
    const { handle, port } = setupServer({ automationRuleStoreForAdmin: store });
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/automations`);
    const body = (await response.json()) as { rules: Array<{ timeOfDay: string; instruction: string; enabled: boolean }> };
    expect(response.status).toBe(200);
    expect(body.rules.length).toBe(2);
    expect(body.rules.map((r) => r.instruction)).toContain("check the weather");
  });

  test("requires the admin token when one is configured", async () => {
    const store = new AutomationRuleStore();
    const { handle, port } = setupServer({ automationRuleStoreForAdmin: store, adminToken: "correct-token" });
    activeHandle = handle;
    const response = await fetch(`http://localhost:${port}/automations`);
    expect(response.status).toBe(401);
  });
});

describe("GET /cost-analytics", () => {
  let activeHandle: { stop: () => void } | undefined;
  afterEach(() => {
    activeHandle?.stop();
    activeHandle = undefined;
  });

  test("404s when no CostTracker is configured", async () => {
    const { handle, port } = setupServer();
    activeHandle = handle;
    const response = await fetch(`http://localhost:${port}/cost-analytics`);
    expect(response.status).toBe(404);
  });

  test("reports today/month totals, a per-provider breakdown, and recent calls", async () => {
    const costTracker = new CostTracker();
    const today = new Date().toISOString();
    costTracker.record("anthropic", 0.05, today);
    costTracker.record("groq", 0, today);
    const { handle, port } = setupServer({ costTrackerForAdmin: costTracker });
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/cost-analytics`);
    const body = (await response.json()) as {
      todaySpendUsd: number;
      monthSpendUsd: number;
      byProvider: Array<{ provider: string; totalUsd: number; calls: number }>;
      recent: Array<{ provider: string }>;
    };
    expect(response.status).toBe(200);
    expect(body.todaySpendUsd).toBeCloseTo(0.05);
    expect(body.monthSpendUsd).toBeCloseTo(0.05);
    expect(body.byProvider.find((p) => p.provider === "anthropic")?.totalUsd).toBeCloseTo(0.05);
    expect(body.byProvider.find((p) => p.provider === "groq")?.calls).toBe(1);
    expect(body.recent.length).toBe(2);
  });

  test("rejects a non-positive-integer ?limit=", async () => {
    const costTracker = new CostTracker();
    const { handle, port } = setupServer({ costTrackerForAdmin: costTracker });
    activeHandle = handle;
    const response = await fetch(`http://localhost:${port}/cost-analytics?limit=0`);
    expect(response.status).toBe(400);
  });
});

describe("GET /agent-status and POST /agent/stop", () => {
  let activeHandle: { stop: () => void } | undefined;
  afterEach(() => {
    activeHandle?.stop();
    activeHandle = undefined;
  });

  function buildOrchestrator(liveState: JarvisLiveStateTracker) {
    const eventBus = new EventBus();
    const toolRegistry = new ToolRegistry();
    const permissionService = new PermissionService();
    const conversation = new ConversationManager(eventBus);
    const brain = new ScriptedBrain([]); // never resolves — turn stays "in flight" so live state stays active
    return new Orchestrator({ brain, conversation, toolRegistry, permissionService, eventBus, liveState });
  }

  test("404s when no liveStateTracker is configured", async () => {
    const { handle, port } = setupServer();
    activeHandle = handle;
    const response = await fetch(`http://localhost:${port}/agent-status`);
    expect(response.status).toBe(404);
  });

  test("lists a session's live state once a turn has started", async () => {
    const liveStateTracker = new JarvisLiveStateTracker();
    const orchestrator = buildOrchestrator(liveStateTracker);
    const { handle, port } = setupServer({ liveStateTracker, webChatOrchestrator: orchestrator });
    activeHandle = handle;

    // Fire a turn without awaiting it — the ScriptedBrain never resolves,
    // so the session sits in THINKING until requestStop interrupts it.
    void orchestrator.handleUserMessage("alice", "hello");
    await new Promise((resolve) => setTimeout(resolve, 20));

    const response = await fetch(`http://localhost:${port}/agent-status`);
    const body = (await response.json()) as { sessions: Array<{ sessionId: string; userId: string; state: string }> };
    expect(response.status).toBe(200);
    const session = body.sessions.find((s) => s.userId === "alice");
    expect(session).toBeDefined();
    expect(session?.state).toBe("THINKING");
  });

  test("POST /agent/stop 404s when no webChatOrchestrator is configured", async () => {
    const liveStateTracker = new JarvisLiveStateTracker();
    const { handle, port } = setupServer({ liveStateTracker });
    activeHandle = handle;
    const response = await fetch(`http://localhost:${port}/agent/stop`, {
      method: "POST",
      body: JSON.stringify({ userId: "alice" }),
    });
    expect(response.status).toBe(404);
  });

  test("POST /agent/stop interrupts an active session", async () => {
    const liveStateTracker = new JarvisLiveStateTracker();
    const orchestrator = buildOrchestrator(liveStateTracker);
    const { handle, port } = setupServer({ liveStateTracker, webChatOrchestrator: orchestrator });
    activeHandle = handle;

    void orchestrator.handleUserMessage("bob", "hello");
    await new Promise((resolve) => setTimeout(resolve, 20));

    const response = await fetch(`http://localhost:${port}/agent/stop`, {
      method: "POST",
      body: JSON.stringify({ userId: "bob" }),
    });
    const body = (await response.json()) as { stopped: boolean };
    expect(response.status).toBe(200);
    expect(body.stopped).toBe(true);

    expect(liveStateTracker.getState("chat:bob")).toBe("STOPPED");
  });

  test("POST /agent/stop rejects a missing userId", async () => {
    const liveStateTracker = new JarvisLiveStateTracker();
    const orchestrator = buildOrchestrator(liveStateTracker);
    const { handle, port } = setupServer({ liveStateTracker, webChatOrchestrator: orchestrator });
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/agent/stop`, { method: "POST", body: JSON.stringify({}) });
    expect(response.status).toBe(400);
  });
});

describe("GET /agent-recent-activity", () => {
  let activeHandle: { stop: () => void } | undefined;
  afterEach(() => {
    activeHandle?.stop();
    activeHandle = undefined;
  });

  test("404s when no toolAuditLog is configured", async () => {
    const { handle, port } = setupServer();
    activeHandle = handle;
    const response = await fetch(`http://localhost:${port}/agent-recent-activity?sessionId=chat:alice`);
    expect(response.status).toBe(404);
  });

  test("requires sessionId", async () => {
    const toolAuditLog = new ToolAuditLog(":memory:");
    const { handle, port } = setupServer({ toolAuditLog });
    activeHandle = handle;
    const response = await fetch(`http://localhost:${port}/agent-recent-activity`);
    expect(response.status).toBe(400);
  });

  test("returns a session's persisted transition history, most recent first", async () => {
    const toolAuditLog = new ToolAuditLog(":memory:");
    toolAuditLog.recordLiveStateTransition({ sessionId: "chat:alice", userId: "alice", from: "IDLE", to: "LISTENING", reason: "user message received" });
    toolAuditLog.recordLiveStateTransition({ sessionId: "chat:alice", userId: "alice", from: "LISTENING", to: "THINKING" });
    const { handle, port } = setupServer({ toolAuditLog });
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/agent-recent-activity?sessionId=chat:alice`);
    const body = (await response.json()) as { transitions: Array<{ toState: string; fromState: string }> };
    expect(response.status).toBe(200);
    expect(body.transitions).toHaveLength(2);
    expect(body.transitions[0]?.toState).toBe("THINKING");
  });

  test("requires the admin token when one is configured", async () => {
    const toolAuditLog = new ToolAuditLog(":memory:");
    const { handle, port } = setupServer({ toolAuditLog, adminToken: "correct-token" });
    activeHandle = handle;
    const response = await fetch(`http://localhost:${port}/agent-recent-activity?sessionId=chat:alice`);
    expect(response.status).toBe(401);
  });
});

describe("POST /agent/stop also cancels an in-flight agent task via agentTaskCanceller", () => {
  let activeHandle: { stop: () => void } | undefined;
  afterEach(() => {
    activeHandle?.stop();
    activeHandle = undefined;
  });

  test("returns stopped: true when only an agent task (no live chat turn) was active", async () => {
    const liveStateTracker = new JarvisLiveStateTracker();
    const eventBus = new EventBus();
    const toolRegistry = new ToolRegistry();
    const permissionService = new PermissionService();
    const conversation = new ConversationManager(eventBus);
    let cancelledFor: string | undefined;
    const orchestrator = new Orchestrator({
      brain: new ScriptedBrain([]),
      conversation,
      toolRegistry,
      permissionService,
      eventBus,
      liveState: liveStateTracker,
      agentTaskCanceller: {
        cancelActiveTasksForUser: (userId) => {
          cancelledFor = userId;
          return ["task-1"];
        },
      },
    });
    const { handle, port } = setupServer({ liveStateTracker, webChatOrchestrator: orchestrator });
    activeHandle = handle;

    // No live chat turn at all — the session is still IDLE, so
    // `liveState.requestStop` alone would report nothing to stop.
    const response = await fetch(`http://localhost:${port}/agent/stop`, {
      method: "POST",
      body: JSON.stringify({ userId: "carol" }),
    });
    const body = (await response.json()) as { stopped: boolean };
    expect(response.status).toBe(200);
    expect(body.stopped).toBe(true);
    expect(cancelledFor).toBe("carol");
  });
});

describe("GET /command-center (static page)", () => {
  let activeHandle: { stop: () => void } | undefined;
  afterEach(() => {
    activeHandle?.stop();
    activeHandle = undefined;
  });

  test("redirects /command-center to /command-center/", async () => {
    const { handle, port } = setupServer();
    activeHandle = handle;
    const response = await fetch(`http://localhost:${port}/command-center`, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/command-center/");
  });

  test("serves the command center page and it never embeds the admin token", async () => {
    const { handle, port } = setupServer({ adminToken: "correct-token" });
    activeHandle = handle;
    const response = await fetch(`http://localhost:${port}/command-center/`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("<title>JARVIS Command Center</title>");
    expect(html).not.toContain("correct-token");
  });

  test("a path-traversal attempt under /command-center/ never returns file content outside ui/command-center/", async () => {
    const { handle, port } = setupServer();
    activeHandle = handle;
    const response = await fetch(`http://localhost:${port}/command-center/%2e%2e/%2e%2e/etc/passwd`);
    const text = await response.text();
    expect(text).not.toContain("root:");
    expect(text).not.toMatch(/<title>JARVIS Command Center<\/title>/);
  });
});
