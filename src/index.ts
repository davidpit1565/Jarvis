import { createInterface } from "node:readline/promises";
import { loadConfig } from "@/config";
import { EventBus } from "@/core/events/EventBus";
import { ConversationManager } from "@/core/conversation/ConversationManager";
import { ClaudeBrain } from "@/core/brain/ClaudeBrain";
import { Orchestrator } from "@/core/orchestrator/Orchestrator";
import { ConfirmationService, type ConfirmationRequest } from "@/core/confirmation/ConfirmationService";
import { ToolRegistry } from "@/tools/registry/ToolRegistry";
import { PermissionService } from "@/permissions/PermissionService";
import { readOnlyFileInfoTool } from "@/tools/filesystem/ReadOnlyFileInfoTool";
import { getActiveApplicationTool } from "@/tools/system/GetActiveApplicationTool";
import { createSaveMemoryTool } from "@/tools/memory/SaveMemoryTool";
import { createSearchMemoryTool } from "@/tools/memory/SearchMemoryTool";
import { MemoryStore } from "@/memory/MemoryStore";
import { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import { PairingService } from "@/devices/pairing/PairingService";
import { DeviceConnectionManager } from "@/communication/websocket/DeviceConnectionManager";
import { JarvisWebSocketServer } from "@/communication/websocket/JarvisWebSocketServer";
import { TwilioVoiceGateway, type PhoneSession } from "@/communication/phone/TwilioVoiceGateway";
import { ActivityLog } from "@/core/activity/ActivityLog";

const DEFAULT_USER_ID = "local-user";

// Shared across the chat loop and any confirmation prompts it triggers —
// there is only ever one reader of stdin, and confirmation questions are
// always asked (and resolved) from inside a single in-flight chat turn,
// never concurrently with the loop's own next question() call.
const rl = createInterface({ input: process.stdin, output: process.stdout });

function main() {
  const config = loadConfig();

  const eventBus = new EventBus();
  const toolRegistry = new ToolRegistry();
  const memoryStore = new MemoryStore(config.memoryDbPath);
  const activityLog = new ActivityLog();

  toolRegistry.registerTool(readOnlyFileInfoTool);
  toolRegistry.registerTool(getActiveApplicationTool);
  toolRegistry.registerTool(createSaveMemoryTool(memoryStore));
  toolRegistry.registerTool(createSearchMemoryTool(memoryStore));

  const permissionService = new PermissionService();
  // This is a single-user personal assistant, not a multi-tenant system —
  // memory writes are SAFE_ACTION-level but standing-granted to the one
  // local user rather than asked about every time.
  permissionService.grant(DEFAULT_USER_ID, "SAVE_MEMORY");

  const deviceRegistry = new DeviceRegistry();
  const pairingService = new PairingService();
  const deviceConnectionManager = new DeviceConnectionManager(eventBus);
  const conversation = new ConversationManager(eventBus);
  const brain = new ClaudeBrain(config.anthropicApiKey);
  const confirmationService = new ConfirmationService(confirmViaChat);

  const orchestrator = new Orchestrator({
    brain,
    conversation,
    toolRegistry,
    permissionService,
    eventBus,
    deviceRegistry,
    deviceConnectionManager,
    confirmationService,
  });

  // A phone call gets its own conversation thread (a fresh ConversationManager
  // + Orchestrator) but shares every other live instance — same JARVIS,
  // separate conversation. Only wired up when both Twilio settings are
  // present; otherwise the /voice/* routes 404 and nothing changes.
  function createPhoneSession(_callSid: string): PhoneSession {
    const phoneConversation = new ConversationManager(eventBus);
    const phoneOrchestrator = new Orchestrator({
      brain,
      conversation: phoneConversation,
      toolRegistry,
      permissionService,
      eventBus,
      deviceRegistry,
      deviceConnectionManager,
      confirmationService,
      channelContext: "This conversation is happening over a live phone call right now.",
    });
    return { orchestrator: phoneOrchestrator, userId: DEFAULT_USER_ID };
  }

  const phoneGateway =
    config.twilioAuthToken && config.twilioPublicBaseUrl
      ? new TwilioVoiceGateway(createPhoneSession, config.twilioVoice)
      : undefined;

  const wsServer = new JarvisWebSocketServer({
    deviceRegistry,
    deviceConnectionManager,
    pairingService,
    eventBus,
    toolRegistry,
    activityLog,
    phoneGateway,
    twilioAuthToken: config.twilioAuthToken,
    twilioPublicBaseUrl: config.twilioPublicBaseUrl,
    twilioAllowedCallers: config.twilioAllowedCallers,
  });
  wsServer.start(config.port);

  eventBus.on("brain.response", ({ text, toolCallCount }) => {
    console.log(`[jarvis] brain responded (toolCalls=${toolCallCount}): ${text.slice(0, 120)}`);
  });

  eventBus.on("device.registered", ({ device }) => {
    console.log(`[jarvis] device registered: ${device.name} (${device.id}), pending pairing approval`);
    activityLog.record(`Device registered: ${device.name}`);
  });

  eventBus.on("device.connected", ({ deviceId }) => {
    console.log(`[jarvis] device connected: ${deviceId}`);
    activityLog.record(`Device connected: ${deviceId}`);
  });

  eventBus.on("device.disconnected", ({ deviceId, reason }) => {
    console.log(`[jarvis] device disconnected: ${deviceId} (${reason})`);
    activityLog.record(`Device disconnected: ${deviceId} (${reason})`);
  });

  eventBus.on("tool.executed", ({ toolName, result }) => {
    activityLog.record(`${toolName} → ${result.success ? "ok" : `failed: ${result.error}`}`);
  });

  console.log(`JARVIS Core listening on port ${config.port}`);
  console.log(`Registered tools: ${toolRegistry.listTools().map((t) => t.name).join(", ")}`);
  console.log(
    phoneGateway
      ? "Phone gateway: enabled (POST /voice/incoming, /voice/gather, /voice/status)"
      : "Phone gateway: disabled (set TWILIO_AUTH_TOKEN and TWILIO_PUBLIC_BASE_URL to enable)"
  );

  process.on("SIGINT", () => {
    memoryStore.close();
    rl.close();
    process.exit(0);
  });

  runChatLoop(orchestrator);

  // Exposed for future entry points (HTTP handler, CLI, tests).
  return {
    orchestrator,
    memoryStore,
    deviceRegistry,
    pairingService,
    deviceConnectionManager,
    toolRegistry,
    permissionService,
    confirmationService,
    phoneGateway,
    eventBus,
  };
}

/**
 * Asks the human directly in the terminal whether a CONFIRM/DANGEROUS tool
 * call may proceed. This is today's only confirmation channel; a future
 * channel (push notification, phone call) would just be a different
 * ConfirmationPrompter passed to the same ConfirmationService.
 */
async function confirmViaChat(request: ConfirmationRequest): Promise<boolean> {
  const inputSummary = JSON.stringify(request.input);
  const answer = await rl.question(
    `\n⚠️  JARVIS wants to run "${request.toolName}" with input ${inputSummary}. Approve? (yes/no): `
  );
  return answer.trim().toLowerCase().startsWith("y");
}

/**
 * Minimal interactive CLI for talking to JARVIS from the same process that
 * holds the live device connections — this is what actually proves the
 * full loop (Claude -> tool decision -> permission -> device -> result ->
 * Claude -> response) end to end against a real connected device. It has
 * to live in this process, not a separate script, because the device's
 * WebSocket connection and the Orchestrator's registries only exist here.
 */
async function runChatLoop(orchestrator: Orchestrator): Promise<void> {
  console.log("\nJARVIS is ready. Type a message and press Enter (Ctrl+C to quit).\n");

  while (true) {
    let line: string;
    try {
      line = await rl.question("");
    } catch {
      // stdin closed (e.g. a piped input ended, or Ctrl+D) — exit quietly
      // instead of crashing on the next question() call.
      return;
    }

    const message = line.trim();
    if (!message) continue;

    try {
      const response = await orchestrator.handleUserMessage(DEFAULT_USER_ID, message);
      console.log(`\nJARVIS: ${response}\n`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[jarvis] error handling message: ${reason}\n`);
    }
  }
}

if (import.meta.main) {
  main();
}

export { main, DEFAULT_USER_ID };
