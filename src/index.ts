import { createInterface } from "node:readline/promises";
import { dirname } from "node:path";
import { loadConfig } from "@/config";
import { EventBus } from "@/core/events/EventBus";
import { ConversationManager } from "@/core/conversation/ConversationManager";
import { ClaudeBrain, DEFAULT_MODEL } from "@/core/brain/ClaudeBrain";
import { Orchestrator } from "@/core/orchestrator/Orchestrator";
import { ConfirmationService, type ConfirmationRequest } from "@/core/confirmation/ConfirmationService";
import { ToolRegistry } from "@/tools/registry/ToolRegistry";
import { PermissionService } from "@/permissions/PermissionService";
import { readOnlyFileInfoTool } from "@/tools/filesystem/ReadOnlyFileInfoTool";
import { getActiveApplicationTool } from "@/tools/system/GetActiveApplicationTool";
import { openApplicationTool } from "@/tools/system/OpenApplicationTool";
import { createSaveMemoryTool } from "@/tools/memory/SaveMemoryTool";
import { createSearchMemoryTool } from "@/tools/memory/SearchMemoryTool";
import { createDeleteMemoryTool } from "@/tools/memory/DeleteMemoryTool";
import { MemoryStore } from "@/memory/MemoryStore";
import { ReminderStore } from "@/reminders/ReminderStore";
import { buildContextNote } from "@/core/buildContextNote";
import { ToolAuditLog } from "@/audit/ToolAuditLog";
import { TokenUsageStore } from "@/audit/TokenUsageStore";
import { CostAlertMonitor } from "@/audit/CostAlertMonitor";
import { estimateCostUsd } from "@/audit/estimateCostUsd";
import { createCreateReminderTool } from "@/tools/reminders/CreateReminderTool";
import { createListRemindersTool } from "@/tools/reminders/ListRemindersTool";
import { createCompleteReminderTool } from "@/tools/reminders/CompleteReminderTool";
import { createDeleteReminderTool } from "@/tools/reminders/DeleteReminderTool";
import { createUpdateReminderTool } from "@/tools/reminders/UpdateReminderTool";
import { ConversationHistoryStore } from "@/history/ConversationHistoryStore";
import { createSearchConversationHistoryTool } from "@/tools/history/SearchConversationHistoryTool";
import { createClearConversationHistoryTool } from "@/tools/history/ClearConversationHistoryTool";
import { WakeUpCallStore } from "@/wakeup/WakeUpCallStore";
import { getDueWakeUpCalls, formatTimeOfDay, formatDateKey } from "@/wakeup/getDueWakeUpCalls";
import { createCreateWakeUpCallTool } from "@/tools/wakeup/CreateWakeUpCallTool";
import { createListWakeUpCallsTool } from "@/tools/wakeup/ListWakeUpCallsTool";
import { createDeleteWakeUpCallTool } from "@/tools/wakeup/DeleteWakeUpCallTool";
import { createUpdateWakeUpCallTool } from "@/tools/wakeup/UpdateWakeUpCallTool";
import { TwilioOutboundCaller } from "@/communication/phone/TwilioOutboundCaller";
import { CalendarTokenStore } from "@/calendar/CalendarTokenStore";
import { GoogleCalendarClient } from "@/calendar/GoogleCalendarClient";
import { createListCalendarEventsTool } from "@/tools/calendar/ListCalendarEventsTool";
import { createUnlinkCalendarTool } from "@/tools/calendar/UnlinkCalendarTool";
import { createCreateCalendarEventTool } from "@/tools/calendar/CreateCalendarEventTool";
import { createDeleteCalendarEventTool } from "@/tools/calendar/DeleteCalendarEventTool";
import { GmailClient } from "@/gmail/GmailClient";
import { createSearchEmailTool } from "@/tools/gmail/SearchEmailTool";
import { OpenMeteoClient } from "@/weather/OpenMeteoClient";
import { createGetWeatherTool } from "@/tools/weather/GetWeatherTool";
import { RssNewsClient } from "@/news/RssNewsClient";
import { createGetNewsTool } from "@/tools/news/GetNewsTool";
import { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import { PairingService } from "@/devices/pairing/PairingService";
import { DeviceConnectionManager } from "@/communication/websocket/DeviceConnectionManager";
import { JarvisWebSocketServer } from "@/communication/websocket/JarvisWebSocketServer";
import { TwilioVoiceGateway, type PhoneSession } from "@/communication/phone/TwilioVoiceGateway";
import { TelegramGateway, type TelegramSession } from "@/communication/telegram/TelegramGateway";
import { createNotifyUserTool } from "@/tools/telegram/NotifyUserTool";
import { LockdownService } from "@/core/lockdown/LockdownService";
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
// Logs only .message/.stack, never the raw error object — an error type
// with an unexpected enumerable custom property (not something anything
// here constructs today, but not guaranteed of every dependency forever)
// could otherwise get its fields printed wholesale by console.error's
// default object formatting.
process.on("uncaughtException", (error) => {
  console.error("[jarvis] uncaught exception (process continuing):", error.stack ?? error.message);
  activityLogForCrashHandlers?.record(`Uncaught exception: ${error.message}`);
});
process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  const detail = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
  console.error("[jarvis] unhandled promise rejection (process continuing):", detail);
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
  const toolAuditLog = new ToolAuditLog(config.toolAuditLogDbPath);
  const tokenUsageStore = new TokenUsageStore(config.tokenUsageDbPath);
  const costAlertMonitor = config.costAlertThresholdUsd
    ? new CostAlertMonitor(config.costAlertThresholdUsd, (stagePercent, costUsd, thresholdUsd) => {
        const message = `Estimated cost has reached ${Math.round(stagePercent * 100)}% of your $${thresholdUsd} threshold ($${costUsd.toFixed(2)} so far, all-time).`;
        console.warn(`[jarvis] COST ALERT: ${message}`);
        activityLog.record(message);
      })
    : undefined;
  const webAuthnStore = new WebAuthnStore(config.webauthnDbPath);
  const webAuthnService = new WebAuthnService(webAuthnStore);
  const sessionStore = new SessionStore();

  const calendarEnabled = Boolean(config.googleClientId && config.googleClientSecret && config.publicBaseUrl);
  const calendarTokenStore = new CalendarTokenStore(config.calendarTokenDbPath);
  const calendarClient = calendarEnabled
    ? new GoogleCalendarClient(
        config.googleClientId!,
        config.googleClientSecret!,
        new URL("/calendar/oauth/callback", config.publicBaseUrl).toString(),
        calendarTokenStore
      )
    : undefined;
  if (calendarClient) {
    toolRegistry.registerTool(createListCalendarEventsTool(calendarClient));
    toolRegistry.registerTool(createCreateCalendarEventTool(calendarClient));
    toolRegistry.registerTool(createDeleteCalendarEventTool(calendarClient));
    toolRegistry.registerTool(createUnlinkCalendarTool(calendarTokenStore));
  }

  // Shares the same Google account link as Calendar (one OAuth consent
  // screen, two scopes) rather than a second separate account link.
  const gmailClient = calendarEnabled
    ? new GmailClient(config.googleClientId!, config.googleClientSecret!, calendarTokenStore)
    : undefined;
  if (gmailClient) {
    toolRegistry.registerTool(createSearchEmailTool(gmailClient));
  }

  const weatherEnabled = config.weatherLatitude !== undefined && config.weatherLongitude !== undefined;
  if (weatherEnabled) {
    const weatherClient = new OpenMeteoClient(config.weatherLatitude!, config.weatherLongitude!);
    toolRegistry.registerTool(createGetWeatherTool(weatherClient));
  }

  if (config.newsRssUrl) {
    const newsClient = new RssNewsClient(config.newsRssUrl);
    toolRegistry.registerTool(createGetNewsTool(newsClient));
  }

  toolRegistry.registerTool(readOnlyFileInfoTool);
  toolRegistry.registerTool(getActiveApplicationTool);
  toolRegistry.registerTool(openApplicationTool);
  toolRegistry.registerTool(createSaveMemoryTool(memoryStore));
  toolRegistry.registerTool(createSearchMemoryTool(memoryStore));
  toolRegistry.registerTool(createDeleteMemoryTool(memoryStore));
  toolRegistry.registerTool(createCreateReminderTool(reminderStore));
  toolRegistry.registerTool(createListRemindersTool(reminderStore));
  toolRegistry.registerTool(createCompleteReminderTool(reminderStore));
  toolRegistry.registerTool(createDeleteReminderTool(reminderStore));
  toolRegistry.registerTool(createUpdateReminderTool(reminderStore));
  toolRegistry.registerTool(createSearchConversationHistoryTool(conversationHistoryStore));
  toolRegistry.registerTool(createClearConversationHistoryTool(conversationHistoryStore));

  const permissionService = new PermissionService();
  const lockdownService = new LockdownService();
  // This is a single-user personal assistant, not a multi-tenant system —
  // memory writes are SAFE_ACTION-level but standing-granted to the one
  // local user rather than asked about every time.
  permissionService.grant(DEFAULT_USER_ID, "SAVE_MEMORY");
  permissionService.grant(DEFAULT_USER_ID, "DELETE_MEMORY");
  permissionService.grant(DEFAULT_USER_ID, "CREATE_REMINDER");
  permissionService.grant(DEFAULT_USER_ID, "COMPLETE_REMINDER");
  permissionService.grant(DEFAULT_USER_ID, "DELETE_REMINDER");
  permissionService.grant(DEFAULT_USER_ID, "UPDATE_REMINDER");
  // DANGEROUS: granted so the tool is askable at all, but PermissionService
  // still forces a fresh per-invocation confirmation regardless of this
  // grant — this never lets JARVIS erase the transcript silently.
  permissionService.grant(DEFAULT_USER_ID, "CLEAR_CONVERSATION_HISTORY");
  if (calendarClient) {
    permissionService.grant(DEFAULT_USER_ID, "CREATE_CALENDAR_EVENT");
    permissionService.grant(DEFAULT_USER_ID, "DELETE_CALENDAR_EVENT");
    // Same DANGEROUS reasoning as CLEAR_CONVERSATION_HISTORY above.
    permissionService.grant(DEFAULT_USER_ID, "UNLINK_CALENDAR");
  }

  const deviceRegistry = new DeviceRegistry(config.deviceRegistryDbPath);

  // Device-scoped SAFE_ACTION tools a device automatically gets once it's
  // trusted as "primary" — that trust decision (a human approving its
  // pairing code, then granting it the primary role) is already the
  // deliberate, one-time consent step; piggybacking standing tool access
  // on it, rather than inventing a second separate consent step per tool,
  // keeps this consistent with how every other primary-device capability
  // already works. Granted both when a device newly receives the role
  // (via "device.roleGranted") and, since PermissionService's grants are
  // in-memory only, re-derived at startup for any device that already
  // has the role persisted from before a restart.
  const STANDARD_PRIMARY_DEVICE_TOOLS = ["OPEN_APPLICATION"];
  function grantPrimaryDeviceTools(deviceId: string): void {
    for (const toolId of STANDARD_PRIMARY_DEVICE_TOOLS) {
      permissionService.grant(DEFAULT_USER_ID, toolId, deviceId);
    }
  }
  eventBus.on("device.roleGranted", ({ deviceId, role }) => {
    if (role === "primary") grantPrimaryDeviceTools(deviceId);
  });
  for (const device of deviceRegistry.listDevices()) {
    if (device.role === "primary") grantPrimaryDeviceTools(device.id);
  }

  const pairingService = new PairingService(undefined, undefined, config.pairingDbPath);
  const deviceConnectionManager = new DeviceConnectionManager(eventBus);
  const conversation = new ConversationManager(eventBus);
  const brain = new ClaudeBrain(config.anthropicApiKey, {
    webSearchEnabled: config.webSearchEnabled,
    webSearchMaxUses: config.webSearchMaxUses,
    webFetchEnabled: config.webFetchEnabled,
    webFetchMaxUses: config.webFetchMaxUses,
    baseUrl: config.anthropicBaseUrl,
    fallbackModel: config.fallbackModel,
  });
  const confirmationService = new ConfirmationService(confirmViaChat);
  const phoneConfirmationService = new ConfirmationService(denyPhoneConfirmation);

  const orchestrator = new Orchestrator({
    brain,
    conversation,
    toolRegistry,
    permissionService,
    eventBus,
    deviceRegistry,
    deviceConnectionManager,
    confirmationService,
    contextProvider: () => buildContextNote(config, reminderStore, calendarClient),
    lockdownService,
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
      confirmationService: phoneConfirmationService,
      channelContext: "This conversation is happening over a live phone call right now.",
      contextProvider: () => buildContextNote(config, reminderStore, calendarClient),
      lockdownService,
    });
    return { orchestrator: phoneOrchestrator, userId: DEFAULT_USER_ID };
  }

  const wakeUpCallsEnabled = Boolean(
    config.twilioAuthToken &&
      config.twilioPublicBaseUrl &&
      config.twilioAccountSid &&
      config.twilioFromNumber &&
      config.ownerPhoneNumber
  );
  const wakeUpCallStore = new WakeUpCallStore(config.wakeUpCallDbPath);

  // A wake-up call gets its own conversation thread like any other phone
  // call, but with a distinct channelContext: JARVIS placed this call
  // itself (the user didn't call in), and its whole point is to actually
  // get them out of bed, persuading further if they push back, using
  // whatever real context (reminders, memory) is actually relevant today —
  // not the same "how can I help" framing as an inbound call.
  function createWakeUpPhoneSession(_callSid: string): PhoneSession {
    const phoneConversation = new ConversationManager(eventBus);
    const phoneOrchestrator = new Orchestrator({
      brain,
      conversation: phoneConversation,
      toolRegistry,
      permissionService,
      eventBus,
      deviceRegistry,
      deviceConnectionManager,
      confirmationService: phoneConfirmationService,
      channelContext:
        "This is a scheduled wake-up call that JARVIS itself just placed — the user didn't call in, JARVIS " +
        "called them. Open by greeting them and telling them it's time to get up, giving one real, specific, " +
        "motivating reason pulled from what you actually know (check reminders/memory for anything relevant " +
        "today — a meeting, a task, a workout). If they push back or say they're tired, don't just accept it: " +
        "persuade them further with another real, specific reason, the way a determined friend would, rather " +
        "than immediately backing off. Keep replies short and energetic — this is a live phone call.",
      contextProvider: () => buildContextNote(config, reminderStore, calendarClient),
      lockdownService,
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
          config.twilioGatherLanguage,
          createWakeUpPhoneSession,
          config.twilioVoicePitch,
          config.twilioVoiceRate
        )
      : undefined;

  // A Telegram chat gets its own conversation thread, like a phone call,
  // but kept for the life of the process rather than one call's duration —
  // a chat has no natural "hang up." Scoped on purpose: JARVIS only ever
  // sees messages sent to this specific bot, in chats it's been added to.
  function createTelegramSession(_chatId: string): TelegramSession {
    const telegramConversation = new ConversationManager(eventBus);
    const telegramOrchestrator = new Orchestrator({
      brain,
      conversation: telegramConversation,
      toolRegistry,
      permissionService,
      eventBus,
      deviceRegistry,
      deviceConnectionManager,
      confirmationService: phoneConfirmationService,
      channelContext: "This conversation is happening over Telegram right now.",
      contextProvider: () => buildContextNote(config, reminderStore, calendarClient),
      lockdownService,
    });
    return { orchestrator: telegramOrchestrator, userId: DEFAULT_USER_ID };
  }

  const telegramGateway =
    config.telegramBotToken && config.telegramWebhookSecret
      ? new TelegramGateway(config.telegramBotToken, createTelegramSession, config.telegramAllowedChatIds)
      : undefined;

  if (telegramGateway && config.telegramOwnerChatId) {
    toolRegistry.registerTool(createNotifyUserTool(telegramGateway, config.telegramOwnerChatId));
    permissionService.grant(DEFAULT_USER_ID, "NOTIFY_USER");
  }

  let wakeUpInterval: ReturnType<typeof setInterval> | undefined;
  if (wakeUpCallsEnabled) {
    toolRegistry.registerTool(createCreateWakeUpCallTool(wakeUpCallStore));
    toolRegistry.registerTool(createListWakeUpCallsTool(wakeUpCallStore));
    toolRegistry.registerTool(createUpdateWakeUpCallTool(wakeUpCallStore));
    toolRegistry.registerTool(createDeleteWakeUpCallTool(wakeUpCallStore));
    permissionService.grant(DEFAULT_USER_ID, "CREATE_WAKEUP_CALL");
    permissionService.grant(DEFAULT_USER_ID, "UPDATE_WAKEUP_CALL");
    permissionService.grant(DEFAULT_USER_ID, "DELETE_WAKEUP_CALL");

    const outboundCaller = new TwilioOutboundCaller(
      config.twilioAccountSid!,
      config.twilioAuthToken!,
      config.twilioFromNumber!
    );
    const wakeUpTwimlUrl = new URL("/voice/wakeup-connected", config.twilioPublicBaseUrl!).toString();

    // WakeUpCallStore's lastTriggeredDate check makes each tick idempotent
    // ONCE a call has actually completed — but a call stays due for up to
    // two ticks within the same matching minute (checks run every 30s),
    // so a placeCall() that's still in flight when the next tick fires
    // (a slow/stuck network request) would otherwise be dialed again
    // before markTriggered() ever runs. inFlightWakeUpCallIds closes that
    // gap: a call id is tracked as soon as placeCall() starts, not only
    // once it resolves.
    const inFlightWakeUpCallIds = new Set<string>();

    wakeUpInterval = setInterval(() => {
      const now = new Date();
      const nowTimeOfDay = formatTimeOfDay(now, config.timezone);
      const todayDateStr = formatDateKey(now, config.timezone);
      const due = getDueWakeUpCalls(wakeUpCallStore.list(), nowTimeOfDay, todayDateStr, inFlightWakeUpCallIds);

      for (const call of due) {
        inFlightWakeUpCallIds.add(call.id);
        outboundCaller
          .placeCall(config.ownerPhoneNumber!, wakeUpTwimlUrl)
          .then(() => {
            wakeUpCallStore.markTriggered(call.id, todayDateStr);
            activityLog.record(`Placed wake-up call${call.label ? ` (${call.label})` : ""}`);
          })
          .catch((error) => {
            console.error(
              `[jarvis] failed to place wake-up call ${call.id}:`,
              error instanceof Error ? error.message : String(error)
            );
          })
          .finally(() => {
            inFlightWakeUpCallIds.delete(call.id);
          });
      }
    }, 30_000);
  }

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
    telegramGateway,
    telegramWebhookSecret: config.telegramWebhookSecret,
    lockdownService,
    adminToken: config.adminToken,
    webAuthnService,
    sessionStore,
    audioLevelBroadcaster,
    tokenUsageStore,
    reminderStore,
    memoryStore,
    toolAuditLog,
    conversationHistoryStore,
    calendarClient,
    wakeUpCallStore,
    dataDirectory: config.memoryDbPath === ":memory:" ? undefined : dirname(config.memoryDbPath),
    backupDbPaths: [
      config.memoryDbPath,
      config.webauthnDbPath,
      config.remindersDbPath,
      config.activityLogDbPath,
      config.conversationHistoryDbPath,
      config.pairingDbPath,
      config.deviceRegistryDbPath,
      config.toolAuditLogDbPath,
      config.tokenUsageDbPath,
      config.wakeUpCallDbPath,
      config.calendarTokenDbPath,
    ],
  });
  const httpHandle = wsServer.start(config.port);

  eventBus.on("brain.request", () => {
    activityLog.record("JARVIS is thinking…", "thinking");
  });

  eventBus.on("brain.response", ({ text, toolCallCount, serverToolUses, usage }) => {
    console.log(`[jarvis] brain responded (toolCalls=${toolCallCount}): ${text.slice(0, 120)}`);
    if (usage) {
      tokenUsageStore.record(usage);
      if (costAlertMonitor) {
        const costUsd = estimateCostUsd(tokenUsageStore.totals(), DEFAULT_MODEL);
        if (costUsd !== undefined) costAlertMonitor.check(costUsd);
      }
    }
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

  eventBus.on("tool.executed", ({ toolName, result, userId, input }) => {
    toolAuditLog.record(toolName, userId, input, result);
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
  console.log(
    telegramGateway
      ? "Telegram gateway: enabled (POST /telegram/webhook)"
      : "Telegram gateway: disabled (set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET to enable)"
  );
  if (telegramGateway && (!config.telegramAllowedChatIds || config.telegramAllowedChatIds.length === 0)) {
    console.warn(
      "[jarvis] WARNING: Telegram gateway is enabled with no TELEGRAM_ALLOWED_CHAT_IDS set — " +
        "anyone who finds and messages the bot reaches full JARVIS, including tools like SAVE_MEMORY. " +
        "Set TELEGRAM_ALLOWED_CHAT_IDS before sharing the bot with anyone but yourself."
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
    toolAuditLog.close();
    tokenUsageStore.close();
    deviceRegistry.close();
    pairingService.close();
    webAuthnStore.close();
    wakeUpCallStore.close();
    if (wakeUpInterval) clearInterval(wakeUpInterval);
    calendarTokenStore.close();
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
    telegramGateway,
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
 * Phone sessions get their own ConfirmationService using this prompter,
 * instead of sharing confirmViaChat's terminal-bound one — otherwise a
 * CONFIRM/DANGEROUS tool requested mid-call (e.g. UNLINK_CALENDAR,
 * CLEAR_CONVERSATION_HISTORY) would silently hang the live call for the
 * full 60s timeout waiting on a terminal prompt nobody on the phone can
 * see or answer, before auto-denying anyway. This resolves immediately
 * instead, denying the action outright: voice confirmation of a real,
 * high-impact action is inherently unreliable (background noise,
 * misheard "yes", someone else picking up the phone), so an immediate,
 * clear denial — Claude can then tell the caller to do it from the
 * terminal/dashboard instead — is the right behavior here, not a
 * workaround for a technical limitation.
 */
async function denyPhoneConfirmation(request: ConfirmationRequest): Promise<boolean> {
  console.log(`[jarvis] denied "${request.toolName}" over the phone — confirmation isn't supported on this channel`);
  return false;
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
