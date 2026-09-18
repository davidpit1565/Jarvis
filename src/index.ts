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
import { createDeleteMemoryTool } from "@/tools/memory/DeleteMemoryTool";
import { MemoryStore } from "@/memory/MemoryStore";
import { ReminderStore } from "@/reminders/ReminderStore";
import { createCreateReminderTool } from "@/tools/reminders/CreateReminderTool";
import { createListRemindersTool } from "@/tools/reminders/ListRemindersTool";
import { createCompleteReminderTool } from "@/tools/reminders/CompleteReminderTool";
import { ConversationHistoryStore } from "@/history/ConversationHistoryStore";
import { createSearchConversationHistoryTool } from "@/tools/history/SearchConversationHistoryTool";
import { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import { PairingService } from "@/devices/pairing/PairingService";
import { DeviceConnectionManager } from "@/communication/websocket/DeviceConnectionManager";
import { JarvisWebSocketServer } from "@/communication/websocket/JarvisWebSocketServer";
import { TwilioVoiceGateway, type PhoneSession } from "@/communication/phone/TwilioVoiceGateway";
import { ActivityLog } from "@/core/activity/ActivityLog";
import { WebAuthnStore } from "@/auth/WebAuthnStore";
import { WebAuthnService } from "@/auth/WebAuthnService";
import { SessionStore } from "@/auth/SessionStore";
import { AudioLevelBroadcaster } from "@/communication/websocket/AudioLevelBroadcaster";

const DEFAULT_USER_ID = "local-user";

// Shared across the chat loop and any confirmation prompts it triggers —
// there is only ever one reader of stdin, and confirmation questions are
// always asked (and resolved) from inside a single in-flight chat turn,
// never concurrently with the loop's own next question() call.
const rl = createInterface({ input: process.stdin, output: process.stdout });

// Set once main() creates the real ActivityLog; the handlers below are
// registered immediately (before config loading or any store is opened)
// so a crash during startup itself is still caught, not just one after
// everything is up — they just log to the console alone until then.
let activityLogForCrashHandlers: { record: (message: string) => void } | undefined;

// A single uncaught throw or rejected promise anywhere in the process (a
// timer callback, a stray `.then()` with no `.catch()`, a bug in code this
// handler doesn't directly touch) would otherwise crash the entire Bun
// process — taking down every open phone call and device connection over
// one unrelated bug. Logging and continuing is the right tradeoff for a
// personal assistant that should stay reachable; genuinely fatal errors (a
// corrupted SQLite file, a full disk) still surface loudly in the logs and
// in the dashboard's activity feed, they just don't take the whole process
// down with them.
process.on("uncaughtException", (error) => {
  console.error("[jarvis] uncaught exception (process continuing):", error);
  activityLogForCrashHandlers?.record(`Uncaught exception: ${error.message}`);
});
process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  console.error("[jarvis] unhandled promise rejection (process continuing):", reason);
  activityLogForCrashHandlers?.record(`Unhandled rejection: ${message}`);
});

function main() {
  const config = loadConfig();

  const eventBus = new EventBus();
  const toolRegistry = new ToolRegistry();
  const memoryStore = new MemoryStore(config.memoryDbPath);
  const reminderStore = new ReminderStore(config.remindersDbPath);
  const conversationHistoryStore = new ConversationHistoryStore(config.conversationHistoryDbPath);
  const activityLog = new ActivityLog(config.activityLogDbPath);
  const webAuthnStore = new WebAuthnStore(config.webauthnDbPath);
  const webAuthnService = new WebAuthnService(webAuthnStore);
  const sessionStore = new SessionStore();

  toolRegistry.registerTool(readOnlyFileInfoTool);
  toolRegistry.registerTool(getActiveApplicationTool);
  toolRegistry.registerTool(createSaveMemoryTool(memoryStore));
  toolRegistry.registerTool(createSearchMemoryTool(memoryStore));
  toolRegistry.registerTool(createDeleteMemoryTool(memoryStore));
  toolRegistry.registerTool(createCreateReminderTool(reminderStore));
  toolRegistry.registerTool(createListRemindersTool(reminderStore));
  toolRegistry.registerTool(createCompleteReminderTool(reminderStore));
  toolRegistry.registerTool(createSearchConversationHistoryTool(conversationHistoryStore));

  const permissionService = new PermissionService();
  // This is a single-user personal assistant, not a multi-tenant system —
  // memory writes are SAFE_ACTION-level but standing-granted to the one
  // local user rather than asked about every time.
  permissionService.grant(DEFAULT_USER_ID, "SAVE_MEMORY");
  permissionService.grant(DEFAULT_USER_ID, "DELETE_MEMORY");
  permissionService.grant(DEFAULT_USER_ID, "CREATE_REMINDER");
  permissionService.grant(DEFAULT_USER_ID, "COMPLETE_REMINDER");

  const deviceRegistry = new DeviceRegistry(config.deviceRegistryDbPath);
  const pairingService = new PairingService(undefined, undefined, config.pairingDbPath);
  const deviceConnectionManager = new DeviceConnectionManager(eventBus);
  const conversation = new ConversationManager(eventBus);
  const brain = new ClaudeBrain(config.anthropicApiKey, {
    webSearchEnabled: config.webSearchEnabled,
    webSearchMaxUses: config.webSearchMaxUses,
    webFetchEnabled: config.webFetchEnabled,
    webFetchMaxUses: config.webFetchMaxUses,
  });
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

  // Media Streams is a real, small extra Twilio cost (~$0.004/min on top
  // of call minutes) — only wired up when explicitly enabled, and only
  // meaningful once the phone gateway itself is configured.
  const audioLevelBroadcaster =
    config.audioWaveformEnabled && config.twilioPublicBaseUrl ? new AudioLevelBroadcaster() : undefined;
  const audioStreamUrl = audioLevelBroadcaster
    ? new URL("/voice/audio-stream", config.twilioPublicBaseUrl!.replace(/^http/, "ws")).toString()
    : undefined;

  const phoneGateway =
    config.twilioAuthToken && config.twilioPublicBaseUrl
      ? new TwilioVoiceGateway(
          createPhoneSession,
          config.twilioVoice,
          audioStreamUrl,
          config.twilioVoiceHebrew,
          config.twilioGatherLanguage
        )
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
    adminToken: config.adminToken,
    webAuthnService,
    sessionStore,
    audioLevelBroadcaster,
  });
  const httpHandle = wsServer.start(config.port);

  eventBus.on("brain.request", () => {
    activityLog.record("JARVIS is thinking…", "thinking");
  });

  eventBus.on("brain.response", ({ text, toolCallCount, serverToolUses }) => {
    console.log(`[jarvis] brain responded (toolCalls=${toolCallCount}): ${text.slice(0, 120)}`);
    if (serverToolUses?.includes("web_search")) {
      activityLog.record("Searching the web…", "thinking");
    }
    if (serverToolUses?.includes("web_fetch")) {
      activityLog.record("Reading a page…", "thinking");
    }
    if (text.trim()) activityLog.record(text, "speaking");
  });

  eventBus.on("tool.requested", ({ toolCall }) => {
    activityLog.record(`Running ${toolCall.toolName}…`);
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

  eventBus.on("conversation.message", ({ message }) => {
    // Only user/assistant text turns are worth searching later — tool
    // calls/results are protocol noise, not something a human would ever
    // search for ("what did we talk about"), and are already visible via
    // the activity log's own tool.executed entries.
    if (message.role === "user" || message.role === "assistant") {
      conversationHistoryStore.record(message.role, message.content);
    }
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
  if (audioLevelBroadcaster) {
    console.log("Audio waveform: enabled (Twilio Media Streams — extra cost ~$0.004/min on the Twilio account)");
  }
  if (phoneGateway && (!config.twilioAllowedCallers || config.twilioAllowedCallers.length === 0)) {
    console.warn(
      "[jarvis] WARNING: phone gateway is enabled with no TWILIO_ALLOWED_CALLERS set — " +
        "anyone who calls the configured number reaches full JARVIS, including tools like SAVE_MEMORY. " +
        "Set TWILIO_ALLOWED_CALLERS before giving the number to anyone but yourself."
    );
  }

  activityLogForCrashHandlers = activityLog;

  // SIGTERM is what Fly.io/Docker/Kubernetes actually send for a normal
  // stop or redeploy — SIGINT (Ctrl+C) was the only signal handled before,
  // so a cloud restart previously skipped this cleanup entirely and relied
  // on the runtime being killed out from under open SQLite handles/sockets
  // instead of closing them itself. Both signals now do the same graceful
  // shutdown: stop accepting new connections, close every store, then exit.
  let shuttingDown = false;
  function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[jarvis] received ${signal}, shutting down…`);
    httpHandle.stop();
    memoryStore.close();
    reminderStore.close();
    conversationHistoryStore.close();
    activityLog.close();
    deviceRegistry.close();
    pairingService.close();
    webAuthnStore.close();
    rl.close();
    process.exit(0);
  }
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

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
