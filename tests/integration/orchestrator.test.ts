import { describe, test, expect } from "bun:test";
import { Orchestrator } from "@/core/orchestrator/Orchestrator";
import { ConversationManager } from "@/core/conversation/ConversationManager";
import { EventBus } from "@/core/events/EventBus";
import { ToolRegistry } from "@/tools/registry/ToolRegistry";
import { PermissionService } from "@/permissions/PermissionService";
import { PermissionLevel } from "@/types/permissions";
import { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import { DeviceConnectionManager, type DeviceConnection } from "@/communication/websocket/DeviceConnectionManager";
import { parseDeviceToCoreMessage, type ToolResultMessage } from "@/communication/websocket/protocol";
import type { Brain, BrainRequest, BrainResponse } from "@/types/brain";
import type { DeviceTool, LocalTool } from "@/types/tools";
import { LockdownService } from "@/core/lockdown/LockdownService";
import { ToolResultCache } from "@/core/cache/ToolResultCache";
import { parseQuarantinedToolResult } from "@/core/orchestrator/toolResultQuarantine";
import { ConfirmationService } from "@/core/confirmation/ConfirmationService";

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

function makeEchoTool(id: string, requiredPermission: LocalTool["requiredPermission"] = PermissionLevel.READ): LocalTool {
  return {
    id,
    name: id.toLowerCase(),
    description: "Echoes its input back",
    inputSchema: { type: "object", properties: {} },
    requiredPermission,
    target: "local",
    execute: async (input) => ({ success: true, data: input }),
  };
}

function makeDeviceTool(id: string, requiredPermission: DeviceTool["requiredPermission"] = PermissionLevel.READ): DeviceTool {
  return {
    id,
    name: id.toLowerCase(),
    description: "A device-executed test tool",
    inputSchema: { type: "object", properties: { deviceId: { type: "string" } } },
    requiredPermission,
    target: "device",
  };
}

function setup(
  brain: Brain,
  tools: (LocalTool | DeviceTool)[] = [],
  options: {
    deviceRegistry?: DeviceRegistry;
    deviceConnectionManager?: DeviceConnectionManager;
    lockdownService?: LockdownService;
    toolResultCache?: ToolResultCache;
    confirmationService?: ConfirmationService;
  } = {}
) {
  const eventBus = new EventBus();
  const toolRegistry = new ToolRegistry();
  for (const tool of tools) toolRegistry.registerTool(tool);
  const permissionService = new PermissionService();
  const conversation = new ConversationManager(eventBus);

  const orchestrator = new Orchestrator({
    brain,
    conversation,
    toolRegistry,
    permissionService,
    eventBus,
    deviceRegistry: options.deviceRegistry,
    deviceConnectionManager: options.deviceConnectionManager,
    lockdownService: options.lockdownService,
    toolResultCache: options.toolResultCache,
    confirmationService: options.confirmationService,
  });
  return { orchestrator, conversation, eventBus, toolRegistry, permissionService };
}

/** A fake device connection that hands sent envelopes to a callback, simulating a real agent. */
class MockDeviceConnection implements DeviceConnection {
  public sent: string[] = [];
  constructor(private readonly onSend?: (raw: string) => void) {}

  send(raw: string): void {
    this.sent.push(raw);
    this.onSend?.(raw);
  }
}

describe("Orchestrator integration", () => {
  test("rejects an oversized message before it ever reaches the brain or conversation history", async () => {
    const brain = new ScriptedBrain([]); // would throw if ever called — proves the brain is never reached
    const { orchestrator, conversation } = setup(brain);

    const response = await orchestrator.handleUserMessage("user-1", "x".repeat(8_001));

    expect(response).toContain("too long");
    expect(brain.callCount).toBe(0);
    expect(conversation.getMessages()).toHaveLength(0);
  });

  test("accepts a message right at the length limit", async () => {
    const brain = new ScriptedBrain([{ text: "ok", toolCalls: [], stopReason: "end_turn" }]);
    const { orchestrator } = setup(brain);

    const response = await orchestrator.handleUserMessage("user-1", "x".repeat(8_000));

    expect(response).toBe("ok");
  });

  test("rejects more than 4 images before it ever reaches the brain or conversation history", async () => {
    const brain = new ScriptedBrain([]); // would throw if ever called
    const { orchestrator, conversation } = setup(brain);
    const images = Array.from({ length: 5 }, () => ({ mediaType: "image/png" as const, data: "abc" }));

    const response = await orchestrator.handleUserMessage("user-1", "compare these", images);

    expect(response).toContain("Too many images");
    expect(brain.callCount).toBe(0);
    expect(conversation.getMessages()).toHaveLength(0);
  });

  test("accepts exactly 4 images", async () => {
    const brain = new ScriptedBrain([{ text: "ok", toolCalls: [], stopReason: "end_turn" }]);
    const { orchestrator } = setup(brain);
    const images = Array.from({ length: 4 }, () => ({ mediaType: "image/png" as const, data: "abc" }));

    const response = await orchestrator.handleUserMessage("user-1", "compare these", images);

    expect(response).toBe("ok");
  });

  test("rejects an oversized image before it ever reaches the brain or conversation history", async () => {
    const brain = new ScriptedBrain([]); // would throw if ever called
    const { orchestrator, conversation } = setup(brain);
    const images = [{ mediaType: "image/png" as const, data: "x".repeat(7_000_001) }];

    const response = await orchestrator.handleUserMessage("user-1", "what's this?", images);

    expect(response).toContain("too large");
    expect(brain.callCount).toBe(0);
    expect(conversation.getMessages()).toHaveLength(0);
  });

  test("attaches images to the conversation when the message succeeds", async () => {
    const brain = new ScriptedBrain([{ text: "a robot", toolCalls: [], stopReason: "end_turn" }]);
    const { orchestrator, conversation } = setup(brain);
    const images = [{ mediaType: "image/png" as const, data: "abc" }];

    await orchestrator.handleUserMessage("user-1", "what's this?", images);

    const [userMessage] = conversation.getMessages();
    expect((userMessage as { images?: unknown }).images).toEqual(images);
  });

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

    const { orchestrator, conversation } = setup(brain, [tool]);
    const finalResponse = await orchestrator.handleUserMessage("user-1", "please echo hello world");

    expect(finalResponse).toBe("Done! The tool echoed your input.");

    const messages = conversation.getMessages();
    const toolResult = messages.find((m) => m.role === "tool");
    expect(toolResult).toBeDefined();
    expect(parseQuarantinedToolResult((toolResult as { content: string }).content)).toEqual({
      success: true,
      data: { hello: "world" },
    });
  });

  test("tool.executed carries the userId and exact input, for a durable audit trail", async () => {
    const tool = makeEchoTool("ECHO_TOOL");
    const brain = new ScriptedBrain([
      {
        text: "",
        toolCalls: [{ id: "call-1", toolName: "echo_tool", input: { hello: "world" } }],
        stopReason: "tool_use",
      },
      { text: "done", toolCalls: [], stopReason: "end_turn" },
    ]);

    const { orchestrator, eventBus } = setup(brain, [tool]);
    let captured: { toolName: string; userId: string; input: Record<string, unknown> } | undefined;
    eventBus.on("tool.executed", (payload) => {
      captured = payload;
    });

    await orchestrator.handleUserMessage("user-42", "please echo hello world");

    expect(captured?.toolName).toBe("echo_tool");
    expect(captured?.userId).toBe("user-42");
    expect(captured?.input).toEqual({ hello: "world" });
  });

  test("tool.executed carries a real resultSummary derived from an actual array length, and omits it when there's nothing safe to summarize", async () => {
    const listTool: LocalTool = {
      id: "LIST_EVENTS",
      name: "list_events",
      description: "Lists events",
      inputSchema: { type: "object", properties: {} },
      requiredPermission: PermissionLevel.READ,
      target: "local",
      execute: async () => ({ success: true, data: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }, { id: 7 }] }),
    };
    const brain = new ScriptedBrain([
      { text: "", toolCalls: [{ id: "call-1", toolName: "list_events", input: {} }], stopReason: "tool_use" },
      { text: "done", toolCalls: [], stopReason: "end_turn" },
      { text: "", toolCalls: [{ id: "call-2", toolName: "echo_tool", input: { hello: "world" } }], stopReason: "tool_use" },
      { text: "done", toolCalls: [], stopReason: "end_turn" },
    ]);
    const echoTool = makeEchoTool("ECHO_TOOL");

    const { orchestrator, eventBus } = setup(brain, [listTool, echoTool]);
    const captured: Array<{ toolName: string; resultSummary?: string }> = [];
    eventBus.on("tool.executed", (payload) => captured.push(payload));

    await orchestrator.handleUserMessage("user-1", "list today's calendar events");
    await orchestrator.handleUserMessage("user-1", "echo something");

    const listEvent = captured.find((c) => c.toolName === "list_events");
    expect(listEvent?.resultSummary).toBe("7 results");

    // echo_tool's result is a plain object, not an array — no fabricated
    // summary, the field is simply absent.
    const echoEvent = captured.find((c) => c.toolName === "echo_tool");
    expect(echoEvent?.resultSummary).toBeUndefined();
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
    const parsed = parseQuarantinedToolResult((toolResult as { content: string }).content) as {
      success: boolean;
      error?: string;
      data?: unknown;
    };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/Permission denied/);
  });

  test("emergency lockdown refuses a SAFE_ACTION tool even with a standing grant", async () => {
    const safeTool = makeEchoTool("SAFE_TOOL", PermissionLevel.SAFE_ACTION);
    const brain = new ScriptedBrain([
      { text: "", toolCalls: [{ id: "call-1", toolName: "safe_tool", input: {} }], stopReason: "tool_use" },
      { text: "done", toolCalls: [], stopReason: "end_turn" },
    ]);

    const lockdownService = new LockdownService();
    lockdownService.activate("test");
    const { orchestrator, conversation, permissionService } = setup(brain, [safeTool], { lockdownService });
    permissionService.grant("user-1", safeTool.id);

    await orchestrator.handleUserMessage("user-1", "do the safe thing");

    const toolResult = conversation.getMessages().find((m) => m.role === "tool");
    const parsed = parseQuarantinedToolResult((toolResult as { content: string }).content) as {
      success: boolean;
      error?: string;
      data?: unknown;
    };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/lockdown/i);
  });

  test("emergency lockdown does not block a READ tool", async () => {
    const readTool = makeEchoTool("READ_TOOL");
    const brain = new ScriptedBrain([
      { text: "", toolCalls: [{ id: "call-1", toolName: "read_tool", input: {} }], stopReason: "tool_use" },
      { text: "done", toolCalls: [], stopReason: "end_turn" },
    ]);

    const lockdownService = new LockdownService();
    lockdownService.activate();
    const { orchestrator, conversation } = setup(brain, [readTool], { lockdownService });

    await orchestrator.handleUserMessage("user-1", "just read something");

    const toolResult = conversation.getMessages().find((m) => m.role === "tool");
    const parsed = parseQuarantinedToolResult((toolResult as { content: string }).content) as {
      success: boolean;
      error?: string;
      data?: unknown;
    };
    expect(parsed.success).toBe(true);
  });

  test("lifting lockdown restores normal tool execution", async () => {
    const safeTool = makeEchoTool("SAFE_TOOL2", PermissionLevel.SAFE_ACTION);
    const brain = new ScriptedBrain([
      { text: "", toolCalls: [{ id: "call-1", toolName: "safe_tool2", input: {} }], stopReason: "tool_use" },
      { text: "done", toolCalls: [], stopReason: "end_turn" },
    ]);

    const lockdownService = new LockdownService();
    lockdownService.activate();
    lockdownService.deactivate();
    const { orchestrator, conversation, permissionService } = setup(brain, [safeTool], { lockdownService });
    permissionService.grant("user-1", safeTool.id);

    await orchestrator.handleUserMessage("user-1", "do the safe thing");

    const toolResult = conversation.getMessages().find((m) => m.role === "tool");
    const parsed = parseQuarantinedToolResult((toolResult as { content: string }).content) as {
      success: boolean;
      error?: string;
      data?: unknown;
    };
    expect(parsed.success).toBe(true);
  });

  test("appends channelContext to the system prompt for a channel-specific Orchestrator", async () => {
    const eventBus = new EventBus();
    const toolRegistry = new ToolRegistry();
    const permissionService = new PermissionService();
    const conversation = new ConversationManager(eventBus);

    let capturedContext = "";
    const brain: Brain = {
      async chat(request: BrainRequest): Promise<BrainResponse> {
        capturedContext = request.context ?? "";
        return { text: "On a call.", toolCalls: [], stopReason: "end_turn" };
      },
    };

    const orchestrator = new Orchestrator({
      brain,
      conversation,
      toolRegistry,
      permissionService,
      eventBus,
      channelContext: "This conversation is happening over a live phone call right now.",
    });

    await orchestrator.handleUserMessage("user-1", "hi");

    expect(capturedContext).toContain("live phone call");
  });

  test("appends contextProvider's output to the system prompt, called fresh each turn", async () => {
    const eventBus = new EventBus();
    const toolRegistry = new ToolRegistry();
    const permissionService = new PermissionService();
    const conversation = new ConversationManager(eventBus);

    const capturedContexts: string[] = [];
    const brain: Brain = {
      async chat(request: BrainRequest): Promise<BrainResponse> {
        capturedContexts.push(request.context ?? "");
        return { text: "ok", toolCalls: [], stopReason: "end_turn" };
      },
    };

    let callCount = 0;
    const orchestrator = new Orchestrator({
      brain,
      conversation,
      toolRegistry,
      permissionService,
      eventBus,
      contextProvider: () => {
        callCount++;
        return callCount === 1 ? "You have 1 reminder due." : undefined;
      },
    });

    await orchestrator.handleUserMessage("user-1", "hi");
    await orchestrator.handleUserMessage("user-1", "hi again");

    expect(capturedContexts[0]).toContain("You have 1 reminder due.");
    expect(capturedContexts[1]).not.toContain("reminder due");
  });

  test("a contextProvider returning undefined leaves the system prompt at its default", async () => {
    const eventBus = new EventBus();
    const toolRegistry = new ToolRegistry();
    const permissionService = new PermissionService();
    const conversation = new ConversationManager(eventBus);

    let capturedContext = "";
    const brain: Brain = {
      async chat(request: BrainRequest): Promise<BrainResponse> {
        capturedContext = request.context ?? "";
        return { text: "ok", toolCalls: [], stopReason: "end_turn" };
      },
    };

    const orchestrator = new Orchestrator({
      brain,
      conversation,
      toolRegistry,
      permissionService,
      eventBus,
      contextProvider: () => undefined,
    });

    await orchestrator.handleUserMessage("user-1", "hi");

    expect(capturedContext).not.toContain("undefined");
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
    const parsed = parseQuarantinedToolResult((toolResult as { content: string }).content) as {
      success: boolean;
      error?: string;
      data?: unknown;
    };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/Unknown tool/);
  });
});

describe("Orchestrator remote tool execution", () => {
  function setupWithMockDevice(deviceId = "imac-1") {
    const deviceRegistry = new DeviceRegistry();
    deviceRegistry.registerDevice({
      id: deviceId,
      name: "Test iMac",
      type: "mac",
      platform: "macos",
      agentVersion: "0.1.0",
      protocolVersion: "1",
    });
    deviceRegistry.setRole(deviceId, "primary");

    const eventBus = new EventBus();
    const deviceConnectionManager = new DeviceConnectionManager(eventBus, 50);
    return { deviceRegistry, deviceConnectionManager, eventBus };
  }

  test("executes a device tool end to end against a mocked device", async () => {
    const { deviceRegistry, deviceConnectionManager } = setupWithMockDevice();
    const tool = makeDeviceTool("GET_ACTIVE_APPLICATION_TEST");

    const connection = new MockDeviceConnection((raw) => {
      const parsed = JSON.parse(raw) as { requestId: string; type: string };
      if (parsed.type !== "tool.request") return;
      // Simulate the device responding with a tool.result envelope.
      const resultMessage: ToolResultMessage = {
        requestId: parsed.requestId,
        timestamp: new Date().toISOString(),
        deviceId: "imac-1",
        type: "tool.result",
        payload: { success: true, data: { application: "Google Chrome", bundleId: "com.google.Chrome" } },
      };
      queueMicrotask(() => deviceConnectionManager.handleToolResult(resultMessage));
    });
    deviceConnectionManager.registerConnection("imac-1", connection);

    const brain = new ScriptedBrain([
      {
        text: "",
        toolCalls: [{ id: "call-1", toolName: "get_active_application_test", input: {} }],
        stopReason: "tool_use",
      },
      { text: "You're using Google Chrome.", toolCalls: [], stopReason: "end_turn" },
    ]);

    const { orchestrator, conversation } = setup(brain, [tool], { deviceRegistry, deviceConnectionManager });
    const response = await orchestrator.handleUserMessage("user-1", "what am I using?");

    expect(response).toBe("You're using Google Chrome.");
    const toolResult = conversation.getMessages().find((m) => m.role === "tool");
    const parsed = parseQuarantinedToolResult((toolResult as { content: string }).content) as {
      success: boolean;
      error?: string;
      data?: unknown;
    };
    expect(parsed).toEqual({ success: true, data: { application: "Google Chrome", bundleId: "com.google.Chrome" } });
  });

  test("rejects a device tool call whose input fails validateInput before ever contacting the device", async () => {
    const { deviceRegistry, deviceConnectionManager } = setupWithMockDevice();
    let sent = false;
    const tool: DeviceTool = {
      id: "VALIDATED_TOOL",
      name: "validated_tool",
      description: "A device tool with its own input validation",
      inputSchema: { type: "object", properties: { url: { type: "string" } } },
      requiredPermission: PermissionLevel.SAFE_ACTION,
      target: "device",
      validateInput: (input) => (input.url === "javascript:evil()" ? { valid: false, reason: "bad scheme" } : { valid: true }),
    };
    // A connection that would flag if the (invalid) request ever reached it.
    deviceConnectionManager.registerConnection(
      "imac-1",
      new MockDeviceConnection(() => {
        sent = true;
      })
    );

    const brain = new ScriptedBrain([
      {
        text: "",
        toolCalls: [{ id: "call-1", toolName: "validated_tool", input: { url: "javascript:evil()" } }],
        stopReason: "tool_use",
      },
      { text: "Done.", toolCalls: [], stopReason: "end_turn" },
    ]);

    const { orchestrator, conversation, permissionService } = setup(brain, [tool], { deviceRegistry, deviceConnectionManager });
    permissionService.grant("user-1", "VALIDATED_TOOL", "imac-1");
    await orchestrator.handleUserMessage("user-1", "open that link");

    expect(sent).toBe(false);
    const toolResult = conversation.getMessages().find((m) => m.role === "tool");
    const parsed = parseQuarantinedToolResult((toolResult as { content: string }).content) as {
      success: boolean;
      error?: string;
      data?: unknown;
    };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/invalid input.*bad scheme/i);
  });

  test("times out a device tool call when the device never responds", async () => {
    const { deviceRegistry, deviceConnectionManager } = setupWithMockDevice();
    const tool = makeDeviceTool("SLOW_TOOL");

    // Connection accepts the send but the device never sends a tool.result back.
    deviceConnectionManager.registerConnection("imac-1", new MockDeviceConnection());

    const brain = new ScriptedBrain([
      { text: "", toolCalls: [{ id: "call-1", toolName: "slow_tool", input: {} }], stopReason: "tool_use" },
      { text: "That took too long.", toolCalls: [], stopReason: "end_turn" },
    ]);

    const { orchestrator, conversation } = setup(brain, [tool], { deviceRegistry, deviceConnectionManager });
    await orchestrator.handleUserMessage("user-1", "run the slow tool");

    const toolResult = conversation.getMessages().find((m) => m.role === "tool");
    const parsed = parseQuarantinedToolResult((toolResult as { content: string }).content) as {
      success: boolean;
      error?: string;
      data?: unknown;
    };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/timed out/i);
  });

  test("rejects a pending device tool call when the device disconnects", async () => {
    const { deviceRegistry, deviceConnectionManager } = setupWithMockDevice();
    const tool = makeDeviceTool("DISCONNECT_TOOL");

    // Disconnect the instant the tool.request is actually sent (i.e. once the
    // request is truly pending), rather than racing ahead of it.
    const connection = new MockDeviceConnection(() => {
      queueMicrotask(() => deviceConnectionManager.handleDisconnect("imac-1", "socket_closed"));
    });
    deviceConnectionManager.registerConnection("imac-1", connection);

    const brain = new ScriptedBrain([
      { text: "", toolCalls: [{ id: "call-1", toolName: "disconnect_tool", input: {} }], stopReason: "tool_use" },
      { text: "The device disconnected.", toolCalls: [], stopReason: "end_turn" },
    ]);

    const { orchestrator, conversation } = setup(brain, [tool], { deviceRegistry, deviceConnectionManager });
    await orchestrator.handleUserMessage("user-1", "run the tool");

    const toolResult = conversation.getMessages().find((m) => m.role === "tool");
    const parsed = parseQuarantinedToolResult((toolResult as { content: string }).content) as {
      success: boolean;
      error?: string;
      data?: unknown;
    };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/disconnected/i);
  });

  test("reports an unknown device when the requested deviceId has no registered device", async () => {
    const { deviceConnectionManager } = setupWithMockDevice();
    const deviceRegistry = new DeviceRegistry(); // empty: no primary, no devices at all
    const tool = makeDeviceTool("NO_DEVICE_TOOL");

    const brain = new ScriptedBrain([
      { text: "", toolCalls: [{ id: "call-1", toolName: "no_device_tool", input: {} }], stopReason: "tool_use" },
      { text: "No device is available.", toolCalls: [], stopReason: "end_turn" },
    ]);

    const { orchestrator, conversation } = setup(brain, [tool], { deviceRegistry, deviceConnectionManager });
    await orchestrator.handleUserMessage("user-1", "run the tool");

    const toolResult = conversation.getMessages().find((m) => m.role === "tool");
    const parsed = parseQuarantinedToolResult((toolResult as { content: string }).content) as {
      success: boolean;
      error?: string;
      data?: unknown;
    };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/no primary device/i);
  });

  test("reports an unknown explicit deviceId even if a primary device exists", async () => {
    const { deviceRegistry, deviceConnectionManager } = setupWithMockDevice();
    const tool = makeDeviceTool("EXPLICIT_DEVICE_TOOL");

    const brain = new ScriptedBrain([
      {
        text: "",
        toolCalls: [{ id: "call-1", toolName: "explicit_device_tool", input: { deviceId: "macbook-99" } }],
        stopReason: "tool_use",
      },
      { text: "That device isn't registered.", toolCalls: [], stopReason: "end_turn" },
    ]);

    const { orchestrator, conversation } = setup(brain, [tool], { deviceRegistry, deviceConnectionManager });
    await orchestrator.handleUserMessage("user-1", "run on macbook-99");

    const toolResult = conversation.getMessages().find((m) => m.role === "tool");
    const parsed = parseQuarantinedToolResult((toolResult as { content: string }).content) as {
      success: boolean;
      error?: string;
      data?: unknown;
    };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/Unknown device: macbook-99/);
  });

  test("denies a device tool above READ without a device-scoped grant", async () => {
    const { deviceRegistry, deviceConnectionManager } = setupWithMockDevice();
    const tool = makeDeviceTool("SAFE_DEVICE_TOOL", PermissionLevel.SAFE_ACTION);
    deviceConnectionManager.registerConnection("imac-1", new MockDeviceConnection());

    const brain = new ScriptedBrain([
      { text: "", toolCalls: [{ id: "call-1", toolName: "safe_device_tool", input: {} }], stopReason: "tool_use" },
      { text: "Not authorized.", toolCalls: [], stopReason: "end_turn" },
    ]);

    const { orchestrator, conversation } = setup(brain, [tool], { deviceRegistry, deviceConnectionManager });
    await orchestrator.handleUserMessage("user-1", "do the safe action");

    const toolResult = conversation.getMessages().find((m) => m.role === "tool");
    const parsed = parseQuarantinedToolResult((toolResult as { content: string }).content) as {
      success: boolean;
      error?: string;
      data?: unknown;
    };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/Permission denied/);
  });

  test("a grant scoped to one device does not authorize the same tool on another device", async () => {
    const { deviceRegistry, deviceConnectionManager } = setupWithMockDevice("imac-1");
    deviceRegistry.registerDevice({
      id: "macbook-1",
      name: "MacBook",
      type: "mac",
      platform: "macos",
      agentVersion: "0.1.0",
      protocolVersion: "1",
    });
    deviceConnectionManager.registerConnection("macbook-1", new MockDeviceConnection());

    const tool = makeDeviceTool("SCOPED_TOOL", PermissionLevel.SAFE_ACTION);

    const eventBus = new EventBus();
    const toolRegistry = new ToolRegistry();
    toolRegistry.registerTool(tool);
    const permissionService = new PermissionService();
    permissionService.grant("user-1", tool.id, "imac-1"); // only the iMac is granted

    const conversation = new ConversationManager(eventBus);
    const brain = new ScriptedBrain([
      {
        text: "",
        toolCalls: [{ id: "call-1", toolName: "scoped_tool", input: { deviceId: "macbook-1" } }],
        stopReason: "tool_use",
      },
      { text: "Not authorized on that device.", toolCalls: [], stopReason: "end_turn" },
    ]);

    const orchestrator = new Orchestrator({
      brain,
      conversation,
      toolRegistry,
      permissionService,
      eventBus,
      deviceRegistry,
      deviceConnectionManager,
    });

    await orchestrator.handleUserMessage("user-1", "run on the macbook");

    const toolResult = conversation.getMessages().find((m) => m.role === "tool");
    const parsed = parseQuarantinedToolResult((toolResult as { content: string }).content) as {
      success: boolean;
      error?: string;
      data?: unknown;
    };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/Permission denied/);
  });

  test("a malformed tool.result payload is rejected by protocol parsing before it can resolve anything", () => {
    const raw = JSON.stringify({
      requestId: "req-1",
      timestamp: new Date().toISOString(),
      deviceId: "imac-1",
      type: "tool.result",
      payload: { success: "not-a-boolean" },
    });

    const result = parseDeviceToCoreMessage(raw);
    expect(result.ok).toBe(false);
  });

  test("a tool.result for an unknown requestId is a no-op, leaving the real request pending", async () => {
    const { deviceConnectionManager } = setupWithMockDevice();
    deviceConnectionManager.registerConnection("imac-1", new MockDeviceConnection());

    const resultPromise = deviceConnectionManager.sendToolRequest("imac-1", "some_tool", {});

    deviceConnectionManager.handleToolResult({
      requestId: "not-the-real-request-id",
      timestamp: new Date().toISOString(),
      deviceId: "imac-1",
      type: "tool.result",
      payload: { success: true },
    });

    // The real request is still pending and will time out (50ms configured in setupWithMockDevice).
    await expect(resultPromise).rejects.toThrow(/timed out/i);
  });

  test("a tool.result whose device doesn't match the original request (requestId mismatch protection) is ignored", async () => {
    const { deviceConnectionManager } = setupWithMockDevice();
    let capturedRequestId = "";
    const connection = new MockDeviceConnection((raw) => {
      capturedRequestId = (JSON.parse(raw) as { requestId: string }).requestId;
    });
    deviceConnectionManager.registerConnection("imac-1", connection);
    deviceConnectionManager.registerConnection("macbook-1", new MockDeviceConnection());

    const resultPromise = deviceConnectionManager.sendToolRequest("imac-1", "some_tool", {});
    await Promise.resolve(); // let the synchronous send() callback populate capturedRequestId

    // A different device replies using the *correct* requestId — must still be ignored,
    // since the request was addressed to "imac-1", not "macbook-1".
    deviceConnectionManager.handleToolResult({
      requestId: capturedRequestId,
      timestamp: new Date().toISOString(),
      deviceId: "macbook-1",
      type: "tool.result",
      payload: { success: true },
    });

    await expect(resultPromise).rejects.toThrow(/timed out/i);
  });
});

describe("Orchestrator READ-tool result caching", () => {
  function makeCountingTool(
    id: string,
    requiredPermission: LocalTool["requiredPermission"] = PermissionLevel.READ
  ): { tool: LocalTool; calls: () => number } {
    let calls = 0;
    const tool: LocalTool = {
      id,
      name: id.toLowerCase(),
      description: "Counts how many times it actually ran",
      inputSchema: { type: "object", properties: { city: { type: "string" } } },
      requiredPermission,
      target: "local",
      execute: async (input) => {
        calls++;
        return { success: true, data: { ...input, callNumber: calls } };
      },
    };
    return { tool, calls: () => calls };
  }

  test("a repeated identical READ tool call is served from cache, not re-executed", async () => {
    const { tool, calls } = makeCountingTool("GET_WEATHER");
    const cache = new ToolResultCache(60_000);
    const brain = new ScriptedBrain([
      { text: "", toolCalls: [{ id: "call-1", toolName: "get_weather", input: { city: "Tel Aviv" } }], stopReason: "tool_use" },
      { text: "sunny", toolCalls: [], stopReason: "end_turn" },
      { text: "", toolCalls: [{ id: "call-2", toolName: "get_weather", input: { city: "Tel Aviv" } }], stopReason: "tool_use" },
      { text: "still sunny", toolCalls: [], stopReason: "end_turn" },
    ]);
    const { orchestrator } = setup(brain, [tool], { toolResultCache: cache });

    await orchestrator.handleUserMessage("user-1", "weather in Tel Aviv?");
    await orchestrator.handleUserMessage("user-1", "weather in Tel Aviv again?");

    expect(calls()).toBe(1); // the tool itself only actually ran once
  });

  test("emits tool.cacheHit on a served-from-cache call", async () => {
    const { tool } = makeCountingTool("GET_WEATHER");
    const cache = new ToolResultCache(60_000);
    const brain = new ScriptedBrain([
      { text: "", toolCalls: [{ id: "call-1", toolName: "get_weather", input: { city: "Tel Aviv" } }], stopReason: "tool_use" },
      { text: "sunny", toolCalls: [], stopReason: "end_turn" },
      { text: "", toolCalls: [{ id: "call-2", toolName: "get_weather", input: { city: "Tel Aviv" } }], stopReason: "tool_use" },
      { text: "still sunny", toolCalls: [], stopReason: "end_turn" },
    ]);
    const { orchestrator, eventBus } = setup(brain, [tool], { toolResultCache: cache });
    const cacheHits: unknown[] = [];
    eventBus.on("tool.cacheHit", (payload) => cacheHits.push(payload));

    await orchestrator.handleUserMessage("user-1", "weather in Tel Aviv?");
    await orchestrator.handleUserMessage("user-1", "weather in Tel Aviv again?");

    expect(cacheHits).toEqual([{ toolName: "get_weather", input: { city: "Tel Aviv" } }]);
  });

  test("a different input is not served from cache", async () => {
    const { tool, calls } = makeCountingTool("GET_WEATHER");
    const cache = new ToolResultCache(60_000);
    const brain = new ScriptedBrain([
      { text: "", toolCalls: [{ id: "call-1", toolName: "get_weather", input: { city: "Tel Aviv" } }], stopReason: "tool_use" },
      { text: "sunny", toolCalls: [], stopReason: "end_turn" },
      { text: "", toolCalls: [{ id: "call-2", toolName: "get_weather", input: { city: "Jerusalem" } }], stopReason: "tool_use" },
      { text: "rainy", toolCalls: [], stopReason: "end_turn" },
    ]);
    const { orchestrator } = setup(brain, [tool], { toolResultCache: cache });

    await orchestrator.handleUserMessage("user-1", "weather in Tel Aviv?");
    await orchestrator.handleUserMessage("user-1", "weather in Jerusalem?");

    expect(calls()).toBe(2);
  });

  test("a SAFE_ACTION (mutating) tool is never cached, even with a cache configured", async () => {
    const { tool, calls } = makeCountingTool("CREATE_REMINDER", PermissionLevel.SAFE_ACTION);
    const cache = new ToolResultCache(60_000);
    const brain = new ScriptedBrain([
      { text: "", toolCalls: [{ id: "call-1", toolName: "create_reminder", input: { city: "Tel Aviv" } }], stopReason: "tool_use" },
      { text: "done", toolCalls: [], stopReason: "end_turn" },
      { text: "", toolCalls: [{ id: "call-2", toolName: "create_reminder", input: { city: "Tel Aviv" } }], stopReason: "tool_use" },
      { text: "done again", toolCalls: [], stopReason: "end_turn" },
    ]);
    const { orchestrator, permissionService } = setup(brain, [tool], { toolResultCache: cache });
    permissionService.grant("user-1", tool.id);

    await orchestrator.handleUserMessage("user-1", "remind me");
    await orchestrator.handleUserMessage("user-1", "remind me again");

    expect(calls()).toBe(2); // ran both times — a SAFE_ACTION tool is never served from cache
  });

  test("with no toolResultCache configured, every call re-runs the tool (today's default behavior)", async () => {
    const { tool, calls } = makeCountingTool("GET_WEATHER");
    const brain = new ScriptedBrain([
      { text: "", toolCalls: [{ id: "call-1", toolName: "get_weather", input: { city: "Tel Aviv" } }], stopReason: "tool_use" },
      { text: "sunny", toolCalls: [], stopReason: "end_turn" },
      { text: "", toolCalls: [{ id: "call-2", toolName: "get_weather", input: { city: "Tel Aviv" } }], stopReason: "tool_use" },
      { text: "still sunny", toolCalls: [], stopReason: "end_turn" },
    ]);
    const { orchestrator } = setup(brain, [tool]); // no toolResultCache

    await orchestrator.handleUserMessage("user-1", "weather in Tel Aviv?");
    await orchestrator.handleUserMessage("user-1", "weather in Tel Aviv again?");

    expect(calls()).toBe(2);
  });

  describe("Fast Path", () => {
    test("a deterministic weather question skips the tool-selection round-trip but still runs the real tool", async () => {
      const weatherTool = makeEchoTool("GET_WEATHER"); // name "get_weather", READ
      // Only ONE scripted brain response: no tool-selection call needed —
      // fast path already knows which tool to run, so the only brain call
      // left is formatting the final reply.
      const brain = new ScriptedBrain([{ text: "It's sunny and 22°C.", toolCalls: [], stopReason: "end_turn" }]);
      const { orchestrator, eventBus } = setup(brain, [weatherTool]);
      const hits: Array<{ userId: string; toolName: string; shape: string }> = [];
      const misses: Array<{ userId: string }> = [];
      eventBus.on("fastPath.hit", (payload) => hits.push(payload));
      eventBus.on("fastPath.miss", (payload) => misses.push(payload));
      const executed: string[] = [];
      eventBus.on("tool.executed", (payload) => executed.push(payload.toolName));

      const reply = await orchestrator.handleUserMessage("user-1", "what's the weather?");

      expect(reply).toBe("It's sunny and 22°C.");
      expect(hits).toEqual([{ userId: "user-1", toolName: "get_weather", shape: "weather.current" }]);
      expect(misses).toHaveLength(0);
      expect(executed).toEqual(["get_weather"]);
      expect(brain.callCount).toBe(1);
    });

    test("a message that doesn't match any known shape falls through unchanged and emits fastPath.miss", async () => {
      const brain = new ScriptedBrain([{ text: "Just chatting.", toolCalls: [], stopReason: "end_turn" }]);
      const { orchestrator, eventBus } = setup(brain);
      const hits: unknown[] = [];
      const misses: Array<{ userId: string }> = [];
      eventBus.on("fastPath.hit", (payload) => hits.push(payload));
      eventBus.on("fastPath.miss", (payload) => misses.push(payload));

      const reply = await orchestrator.handleUserMessage("user-1", "tell me something interesting");

      expect(reply).toBe("Just chatting.");
      expect(hits).toHaveLength(0);
      expect(misses).toEqual([{ userId: "user-1" }]);
    });

    test("a recognized shape whose tool isn't registered falls through to the full path instead of erroring", async () => {
      // No spotify tools registered on this Orchestrator at all.
      const brain = new ScriptedBrain([
        { text: "", toolCalls: [], stopReason: "end_turn" },
      ]);
      const { orchestrator, eventBus } = setup(brain, []);
      const misses: unknown[] = [];
      eventBus.on("fastPath.miss", (payload) => misses.push(payload));

      await orchestrator.handleUserMessage("user-1", "pause the music");

      expect(misses).toHaveLength(1);
    });

    test("fast path still goes through the full permission pipeline — an ungranted SAFE_ACTION tool is denied, not silently executed", async () => {
      const pauseTool = makeEchoTool("PAUSE_MUSIC", PermissionLevel.SAFE_ACTION); // name "pause_music", no grant given
      const brain = new ScriptedBrain([{ text: "I don't have permission to do that yet.", toolCalls: [], stopReason: "end_turn" }]);
      const { orchestrator, eventBus } = setup(brain, [pauseTool]);
      const hits: unknown[] = [];
      const executed: string[] = [];
      eventBus.on("fastPath.hit", (payload) => hits.push(payload));
      eventBus.on("tool.executed", (payload) => executed.push(payload.toolName));

      const reply = await orchestrator.handleUserMessage("user-1", "pause the music");

      // The shape matched (fast path was taken)...
      expect(hits).toHaveLength(1);
      // ...but the tool itself never actually ran, because there was no grant.
      expect(executed).toHaveLength(0);
      expect(reply).toBe("I don't have permission to do that yet.");
    });

    test("a message with extra content beyond a known shape (a city, a song name) never fast-paths", async () => {
      const weatherTool = makeEchoTool("GET_WEATHER");
      const brain = new ScriptedBrain([
        { text: "", toolCalls: [{ id: "call-1", toolName: "get_weather", input: {} }], stopReason: "tool_use" },
        { text: "Sunny in Tel Aviv.", toolCalls: [], stopReason: "end_turn" },
      ]);
      const { orchestrator, eventBus } = setup(brain, [weatherTool]);
      const hits: unknown[] = [];
      eventBus.on("fastPath.hit", (payload) => hits.push(payload));

      const reply = await orchestrator.handleUserMessage("user-1", "weather in Tel Aviv?");

      expect(hits).toHaveLength(0);
      expect(reply).toBe("Sunny in Tel Aviv.");
      expect(brain.callCount).toBe(2); // full tool-selection round-trip, as before
    });
  });

  describe("Observability — runId correlation (Phase 43)", () => {
    test("the tool.executed event for a full-path tool call carries the same runId the brain.chat call used", async () => {
      const weatherTool = makeEchoTool("GET_WEATHER");
      const seenRunIds: (string | undefined)[] = [];
      class CapturingBrain implements Brain {
        private calls = 0;
        constructor(private readonly responses: BrainResponse[]) {}
        async chat(request: BrainRequest): Promise<BrainResponse> {
          seenRunIds.push(request.runId);
          const response = this.responses[this.calls]!;
          this.calls++;
          return response;
        }
      }
      const brain = new CapturingBrain([
        { text: "", toolCalls: [{ id: "call-1", toolName: "get_weather", input: {} }], stopReason: "tool_use" },
        { text: "Sunny.", toolCalls: [], stopReason: "end_turn" },
      ]);
      const { orchestrator, eventBus } = setup(brain, [weatherTool]);
      const executed: Array<{ toolCallId: string; runId?: string }> = [];
      eventBus.on("tool.executed", (payload) => executed.push({ toolCallId: payload.toolCallId, runId: payload.runId }));

      await orchestrator.handleUserMessage("user-1", "weather in Tel Aviv?");

      // Both brain.chat calls this turn shared one runId (Denial-of-wallet
      // protection, batch 1) — and the tool call in between used that exact
      // same runId, so a support view could correlate them.
      expect(seenRunIds).toHaveLength(2);
      expect(seenRunIds[0]).toBeDefined();
      expect(seenRunIds[0]).toBe(seenRunIds[1]);
      expect(executed).toHaveLength(1);
      expect(executed[0]!.toolCallId).toBe("call-1");
      expect(executed[0]!.runId).toBe(seenRunIds[0]);
    });

    test("Fast Path's tool.executed event also carries the turn's runId", async () => {
      const weatherTool = makeEchoTool("GET_WEATHER");
      const brain = new ScriptedBrain([{ text: "Sunny.", toolCalls: [], stopReason: "end_turn" }]);
      const { orchestrator, eventBus } = setup(brain, [weatherTool]);
      const executed: Array<{ toolCallId: string; runId?: string }> = [];
      eventBus.on("tool.executed", (payload) => executed.push({ toolCallId: payload.toolCallId, runId: payload.runId }));

      await orchestrator.handleUserMessage("user-1", "what's the weather?");

      expect(executed).toHaveLength(1);
      expect(executed[0]!.runId).toBeDefined();
      expect(typeof executed[0]!.toolCallId).toBe("string");
    });
  });

  describe("Parallel Tool Execution", () => {
    function makeTimedReadTool(id: string, delayMs: number, order: string[]): LocalTool {
      return {
        id,
        name: id.toLowerCase(),
        description: "A READ tool that takes a while",
        inputSchema: { type: "object", properties: {} },
        requiredPermission: PermissionLevel.READ,
        target: "local",
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          order.push(id);
          return { success: true, data: {} };
        },
      };
    }

    test("two independent READ tool calls in one brain turn run concurrently, not sequentially", async () => {
      const order: string[] = [];
      const toolA = makeTimedReadTool("TOOL_A", 50, order);
      const toolB = makeTimedReadTool("TOOL_B", 50, order);
      const brain = new ScriptedBrain([
        {
          text: "",
          toolCalls: [
            { id: "call-1", toolName: "tool_a", input: {} },
            { id: "call-2", toolName: "tool_b", input: {} },
          ],
          stopReason: "tool_use",
        },
        { text: "done", toolCalls: [], stopReason: "end_turn" },
      ]);
      const { orchestrator } = setup(brain, [toolA, toolB]);

      const start = Date.now();
      const reply = await orchestrator.handleUserMessage("user-1", "check tool a and tool b");
      const elapsedMs = Date.now() - start;

      expect(reply).toBe("done");
      expect(order.sort()).toEqual(["TOOL_A", "TOOL_B"]);
      // Sequential would be >=100ms; concurrent should land close to the
      // 50ms of the slower call alone. Generous margin against CI jitter,
      // while still well under the sequential floor.
      expect(elapsedMs).toBeLessThan(90);
    });

    test("a failure in one parallel READ call doesn't swallow or corrupt its sibling's result", async () => {
      const okTool: LocalTool = {
        id: "OK_TOOL",
        name: "ok_tool",
        description: "",
        inputSchema: { type: "object", properties: {} },
        requiredPermission: PermissionLevel.READ,
        target: "local",
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { success: true, data: { ok: true } };
        },
      };
      const failingTool: LocalTool = {
        id: "FAILING_TOOL",
        name: "failing_tool",
        description: "",
        inputSchema: { type: "object", properties: {} },
        requiredPermission: PermissionLevel.READ,
        target: "local",
        execute: async () => ({ success: false, error: "boom" }),
      };
      const brain = new ScriptedBrain([
        {
          text: "",
          toolCalls: [
            { id: "call-1", toolName: "ok_tool", input: {} },
            { id: "call-2", toolName: "failing_tool", input: {} },
          ],
          stopReason: "tool_use",
        },
        { text: "handled", toolCalls: [], stopReason: "end_turn" },
      ]);
      const { orchestrator, eventBus } = setup(brain, [okTool, failingTool]);
      const executed: Array<{ toolName: string; result: { success: boolean } }> = [];
      eventBus.on("tool.executed", (payload) => executed.push({ toolName: payload.toolName, result: payload.result }));

      const reply = await orchestrator.handleUserMessage("user-1", "run both");

      expect(reply).toBe("handled");
      expect(executed.find((e) => e.toolName === "ok_tool")?.result.success).toBe(true);
      expect(executed.find((e) => e.toolName === "failing_tool")?.result.success).toBe(false);
    });

    test("SAFE_ACTION/CONFIRM/DANGEROUS tool calls in the same turn are never parallelized, even with each other", async () => {
      let concurrent = 0;
      let maxConcurrent = 0;
      function makeTrackedDangerousTool(id: string): LocalTool {
        return {
          id,
          name: id.toLowerCase(),
          description: "",
          inputSchema: { type: "object", properties: {} },
          requiredPermission: PermissionLevel.DANGEROUS,
          target: "local",
          execute: async () => {
            concurrent++;
            maxConcurrent = Math.max(maxConcurrent, concurrent);
            await new Promise((resolve) => setTimeout(resolve, 20));
            concurrent--;
            return { success: true, data: {} };
          },
        };
      }
      const dangerousA = makeTrackedDangerousTool("DANGEROUS_A");
      const dangerousB = makeTrackedDangerousTool("DANGEROUS_B");
      const brain = new ScriptedBrain([
        {
          text: "",
          toolCalls: [
            { id: "call-1", toolName: "dangerous_a", input: {} },
            { id: "call-2", toolName: "dangerous_b", input: {} },
          ],
          stopReason: "tool_use",
        },
        { text: "done", toolCalls: [], stopReason: "end_turn" },
      ]);
      const confirmationService = new ConfirmationService(async () => true);
      const { orchestrator, permissionService } = setup(brain, [dangerousA, dangerousB], { confirmationService });
      permissionService.grant("user-1", "DANGEROUS_A");
      permissionService.grant("user-1", "DANGEROUS_B");

      const reply = await orchestrator.handleUserMessage("user-1", "do both dangerous things");

      expect(reply).toBe("done");
      expect(maxConcurrent).toBe(1); // never more than one DANGEROUS call in flight at a time
    });

    test("a READ call is never batched together with a following SAFE_ACTION call", async () => {
      let concurrent = 0;
      let maxConcurrent = 0;
      const readTool: LocalTool = {
        id: "READ_TOOL",
        name: "read_tool",
        description: "",
        inputSchema: { type: "object", properties: {} },
        requiredPermission: PermissionLevel.READ,
        target: "local",
        execute: async () => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((resolve) => setTimeout(resolve, 20));
          concurrent--;
          return { success: true, data: {} };
        },
      };
      const safeActionTool: LocalTool = {
        id: "SAFE_TOOL",
        name: "safe_tool",
        description: "",
        inputSchema: { type: "object", properties: {} },
        requiredPermission: PermissionLevel.SAFE_ACTION,
        target: "local",
        execute: async () => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((resolve) => setTimeout(resolve, 20));
          concurrent--;
          return { success: true, data: {} };
        },
      };
      const brain = new ScriptedBrain([
        {
          text: "",
          toolCalls: [
            { id: "call-1", toolName: "read_tool", input: {} },
            { id: "call-2", toolName: "safe_tool", input: {} },
          ],
          stopReason: "tool_use",
        },
        { text: "done", toolCalls: [], stopReason: "end_turn" },
      ]);
      const { orchestrator, permissionService } = setup(brain, [readTool, safeActionTool]);
      permissionService.grant("user-1", "SAFE_TOOL");

      await orchestrator.handleUserMessage("user-1", "do both");

      expect(maxConcurrent).toBe(1);
    });
  });
});
