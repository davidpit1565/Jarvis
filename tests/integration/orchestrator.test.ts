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
  options: { deviceRegistry?: DeviceRegistry; deviceConnectionManager?: DeviceConnectionManager } = {}
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
    const parsed = JSON.parse((toolResult as { content: string }).content);
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
    const parsed = JSON.parse((toolResult as { content: string }).content);
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
    const parsed = JSON.parse((toolResult as { content: string }).content);
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
    const parsed = JSON.parse((toolResult as { content: string }).content);
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
    const parsed = JSON.parse((toolResult as { content: string }).content);
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
    const parsed = JSON.parse((toolResult as { content: string }).content);
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
    const parsed = JSON.parse((toolResult as { content: string }).content);
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
    const parsed = JSON.parse((toolResult as { content: string }).content);
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
