import { createInterface } from "node:readline/promises";
import { dirname } from "node:path";
import { loadConfig } from "@/config";
import { EventBus } from "@/core/events/EventBus";
import { JarvisLiveStateTracker } from "@/core/state/JarvisLiveState";
import { ConversationManager } from "@/core/conversation/ConversationManager";
import { ClaudeBrain, DEFAULT_MODEL } from "@/core/brain/ClaudeBrain";
import { GroqBrain } from "@/core/brain/GroqBrain";
import { OpenRouterBrain, OpenRouterPaidModelError } from "@/core/brain/OpenRouterBrain";
import { AIProviderRegistry } from "@/core/brain/AIProviderRegistry";
import { AIRouter } from "@/core/brain/AIRouter";
import { CostTracker } from "@/core/cost/CostTracker";
import type { Brain } from "@/types/brain";
import { Orchestrator } from "@/core/orchestrator/Orchestrator";
import { ToolResultCache } from "@/core/cache/ToolResultCache";
import { ConfirmationService, type ConfirmationRequest } from "@/core/confirmation/ConfirmationService";
import { ToolRegistry } from "@/tools/registry/ToolRegistry";
import { PermissionService } from "@/permissions/PermissionService";
import { readOnlyFileInfoTool } from "@/tools/filesystem/ReadOnlyFileInfoTool";
import { getActiveApplicationTool } from "@/tools/system/GetActiveApplicationTool";
import { listRunningApplicationsTool } from "@/tools/system/ListRunningApplicationsTool";
import { openApplicationTool } from "@/tools/system/OpenApplicationTool";
import { quitApplicationTool } from "@/tools/system/QuitApplicationTool";
import { openUrlTool } from "@/tools/system/OpenUrlTool";
import { listDirectoryTool } from "@/tools/system/ListDirectoryTool";
import { readTextFileTool } from "@/tools/system/ReadTextFileTool";
import { readFileBytesTool } from "@/tools/system/ReadFileBytesTool";
import { listRecentPhotosTool } from "@/tools/system/ListRecentPhotosTool";
import { writeFileTool } from "@/tools/system/WriteFileTool";
import { scheduleMacNotificationTool } from "@/tools/system/ScheduleMacNotificationTool";
import { createListDevicesTool } from "@/tools/devices/ListDevicesTool";
import { composeEmailDraftTool } from "@/tools/system/ComposeEmailDraftTool";
import { clickElementTool } from "@/tools/system/ClickElementTool";
import { typeTextTool } from "@/tools/system/TypeTextTool";
import { setVolumeTool } from "@/tools/system/SetVolumeTool";
import { toggleWifiTool } from "@/tools/system/ToggleWifiTool";
import { createFolderTool } from "@/tools/system/CreateFolderTool";
import { emptyTrashTool } from "@/tools/system/EmptyTrashTool";
import { listMacRemindersTool } from "@/tools/system/ListMacRemindersTool";
import { createMacReminderTool } from "@/tools/system/CreateMacReminderTool";
import { completeMacReminderTool } from "@/tools/system/CompleteMacReminderTool";
import { createSaveMemoryTool } from "@/tools/memory/SaveMemoryTool";
import { createSearchMemoryTool } from "@/tools/memory/SearchMemoryTool";
import { createDeleteMemoryTool } from "@/tools/memory/DeleteMemoryTool";
import { MemoryStore } from "@/memory/MemoryStore";
import { ReminderStore } from "@/reminders/ReminderStore";
import { buildContextNote } from "@/core/buildContextNote";
import { ToolAuditLog } from "@/audit/ToolAuditLog";
import { AgentCore } from "@/agent/AgentCore";
import { AgentTaskStore } from "@/agent/AgentTaskStore";
import { BrainAgentPlanner } from "@/agent/BrainAgentPlanner";
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
import { AutomationRuleStore } from "@/automation/AutomationRuleStore";
import { getDueAutomationRules } from "@/automation/getDueAutomationRules";
import { createCreateAutomationRuleTool } from "@/tools/automation/CreateAutomationRuleTool";
import { createListAutomationRulesTool } from "@/tools/automation/ListAutomationRulesTool";
import { createUpdateAutomationRuleTool } from "@/tools/automation/UpdateAutomationRuleTool";
import { createDeleteAutomationRuleTool } from "@/tools/automation/DeleteAutomationRuleTool";
import { CommitmentStore } from "@/commitments/CommitmentStore";
import { getStaleCommitments } from "@/commitments/getStaleCommitments";
import { createCreateCommitmentTool } from "@/tools/commitments/CreateCommitmentTool";
import { createListCommitmentsTool } from "@/tools/commitments/ListCommitmentsTool";
import { createFulfillCommitmentTool } from "@/tools/commitments/FulfillCommitmentTool";
import { isQuietHours, isSuppressibleByQuietHours, type QuietHoursWindow } from "@/notifications/quietHours";
import { NotificationDedup } from "@/notifications/NotificationDedup";
import { getDueWakeUpCalls, formatTimeOfDay, formatDateKey } from "@/wakeup/getDueWakeUpCalls";
import { createCreateWakeUpCallTool } from "@/tools/wakeup/CreateWakeUpCallTool";
import { createListWakeUpCallsTool } from "@/tools/wakeup/ListWakeUpCallsTool";
import { createDeleteWakeUpCallTool } from "@/tools/wakeup/DeleteWakeUpCallTool";
import { createUpdateWakeUpCallTool } from "@/tools/wakeup/UpdateWakeUpCallTool";
import { AlarmStore } from "@/alarms/AlarmStore";
import { getDueAlarms } from "@/alarms/getDueAlarms";
import { createCreateAlarmTool } from "@/tools/alarms/CreateAlarmTool";
import { createListAlarmsTool } from "@/tools/alarms/ListAlarmsTool";
import { createDeleteAlarmTool } from "@/tools/alarms/DeleteAlarmTool";
import { createUpdateAlarmTool } from "@/tools/alarms/UpdateAlarmTool";
import { TwilioSmsSender } from "@/communication/phone/TwilioSmsSender";
import { createSendSmsTool } from "@/tools/phone/SendSmsTool";
import { TwilioOutboundCaller } from "@/communication/phone/TwilioOutboundCaller";
import { TwilioCostGuard } from "@/communication/phone/TwilioCostGuard";
import { CalendarTokenStore } from "@/calendar/CalendarTokenStore";
import { GoogleCalendarClient } from "@/calendar/GoogleCalendarClient";
import { createListCalendarEventsTool } from "@/tools/calendar/ListCalendarEventsTool";
import { createSearchCalendarEventsTool } from "@/tools/calendar/SearchCalendarEventsTool";
import { createGetCalendarEventTool } from "@/tools/calendar/GetCalendarEventTool";
import { createUpdateCalendarEventTool } from "@/tools/calendar/UpdateCalendarEventTool";
import { createUnlinkCalendarTool } from "@/tools/calendar/UnlinkCalendarTool";
import { createCreateCalendarEventTool } from "@/tools/calendar/CreateCalendarEventTool";
import { createDeleteCalendarEventTool } from "@/tools/calendar/DeleteCalendarEventTool";
import { UndoStore } from "@/core/undo/UndoStore";
import { createUndoLastActionTool } from "@/tools/undo/UndoLastActionTool";
import { GmailClient } from "@/gmail/GmailClient";
import { SpotifyClient } from "@/spotify/SpotifyClient";
import { StudioClient } from "@/studio/StudioClient";
import { createListReelsTool } from "@/tools/studio/ListReelsTool";
import { createGetInstagramStatsTool } from "@/tools/studio/GetInstagramStatsTool";
import { createPublishReelTool } from "@/tools/studio/PublishReelTool";
import { SpotifyTokenStore } from "@/spotify/SpotifyTokenStore";
import { createGetCurrentlyPlayingTool } from "@/tools/spotify/GetCurrentlyPlayingTool";
import { createPlayMusicTool } from "@/tools/spotify/PlayMusicTool";
import { createPauseMusicTool } from "@/tools/spotify/PauseMusicTool";
import { createSkipTrackTool } from "@/tools/spotify/SkipTrackTool";
import { createUnlinkSpotifyTool } from "@/tools/spotify/UnlinkSpotifyTool";
import { createSearchEmailTool } from "@/tools/gmail/SearchEmailTool";
import { createSendEmailTool } from "@/tools/gmail/SendEmailTool";
import { createReplyEmailTool } from "@/tools/gmail/ReplyEmailTool";
import { createGetEmailTool } from "@/tools/gmail/GetEmailTool";
import { createGetUnreadEmailCountTool } from "@/tools/gmail/GetUnreadEmailCountTool";
import { OpenMeteoClient } from "@/weather/OpenMeteoClient";
import { createGetWeatherTool } from "@/tools/weather/GetWeatherTool";
import { createGetWeatherForecastTool } from "@/tools/weather/GetWeatherForecastTool";
import { RssNewsClient } from "@/news/RssNewsClient";
import { createGetNewsTool } from "@/tools/news/GetNewsTool";
import { createSearchNewsTool } from "@/tools/news/SearchNewsTool";
import { isWeeklyDigestDue } from "@/digest/isWeeklyDigestDue";
import { formatWeeklyDigest } from "@/digest/formatWeeklyDigest";
import { isCheckinDue } from "@/digest/isCheckinDue";
import { isMorningBriefingDue } from "@/digest/isMorningBriefingDue";
import { formatMorningBriefing } from "@/digest/formatMorningBriefing";
import { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import { PairingService } from "@/devices/pairing/PairingService";
import { DeviceConnectionManager } from "@/communication/websocket/DeviceConnectionManager";
import { JarvisWebSocketServer } from "@/communication/websocket/JarvisWebSocketServer";
import { TwilioVoiceGateway, type PhoneSession } from "@/communication/phone/TwilioVoiceGateway";
import { TwilioSmsGateway, type SmsSession } from "@/communication/phone/TwilioSmsGateway";
import { TelegramGateway, type TelegramSession } from "@/communication/telegram/TelegramGateway";
import { DeviceVoiceGateway, type DeviceVoiceSession } from "@/communication/voice/DeviceVoiceGateway";
import { createNotifyUserTool } from "@/tools/telegram/NotifyUserTool";
import { createShareFileToPhoneTool } from "@/tools/telegram/ShareFileToPhoneTool";
import { PollinationsImageClient } from "@/images/PollinationsImageClient";
import { createGenerateImageTool } from "@/tools/images/GenerateImageTool";
import { LockdownService } from "@/core/lockdown/LockdownService";
import { ActivityLog } from "@/core/activity/ActivityLog";
import { WebAuthnStore } from "@/auth/WebAuthnStore";
import { WebAuthnService } from "@/auth/WebAuthnService";
import { SessionStore } from "@/auth/SessionStore";
import { AudioLevelBroadcaster } from "@/communication/websocket/AudioLevelBroadcaster";
import { SchedulerHealthTracker } from "@/core/health/SchedulerHealthTracker";
import { AutomationFailureStore } from "@/automation/AutomationFailureStore";
import { Logger } from "@/core/logging/Logger";

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
  // JARVIS's user-facing "what am I doing right now" state machine — the
  // class itself and its observer-broadcast wiring (OBSERVABLE_EVENTS in
  // JarvisWebSocketServer) already existed, but nothing in production
  // ever actually built one until now. Shared across every channel's
  // Orchestrator below (each passes its own `liveStateChannel` so their
  // sessions never collide), and handed to JarvisWebSocketServer for
  // GET /agent-status / POST /agent/stop — JARVIS_ROADMAP_AUDIT.md
  // #187/#195/#196 (Live Agent Monitor / live status / Stop button).
  const liveStateTracker = new JarvisLiveStateTracker(eventBus);
  const toolRegistry = new ToolRegistry();
  const memoryStore = new MemoryStore(config.memoryDbPath);
  const reminderStore = new ReminderStore(config.remindersDbPath, config.timezone);
  const automationRuleStore = new AutomationRuleStore(config.automationRulesDbPath);
  const automationFailureStore = new AutomationFailureStore(config.automationFailuresDbPath);
  // Tracks "is this setInterval loop actually still ticking" for each
  // background scheduler below — see JARVIS_ROADMAP_AUDIT.md #176.
  const schedulerHealthTracker = new SchedulerHealthTracker();
  // Base structured logger for the reliability-relevant call sites new
  // to this pass (scheduler failures, backup verification) — see
  // src/core/logging/Logger.ts's own doc comment for why this isn't a
  // wholesale replacement of the console.log/console.error calls
  // throughout the rest of this file.
  const logger = new Logger("scheduler");
  const commitmentStore = new CommitmentStore(config.commitmentsDbPath);
  // Unset (either JARVIS_QUIET_HOURS_START or _END missing) means quiet
  // hours is disabled entirely — isQuietHours(_, undefined) always
  // returns false, so every proactive-notification check below behaves
  // exactly as before.
  const quietHoursWindow: QuietHoursWindow | undefined =
    config.quietHoursStart && config.quietHoursEnd
      ? { start: config.quietHoursStart, end: config.quietHoursEnd }
      : undefined;
  // Generalizes ReminderStore's own notifiedAt dedup to proactive
  // channels that don't have a persisted per-item flag of their own —
  // see NotificationDedup's own doc comment.
  const notificationDedup = new NotificationDedup();
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
  const undoStore = new UndoStore();
  if (calendarClient) {
    toolRegistry.registerTool(createListCalendarEventsTool(calendarClient));
    toolRegistry.registerTool(createSearchCalendarEventsTool(calendarClient));
    toolRegistry.registerTool(createGetCalendarEventTool(calendarClient));
    toolRegistry.registerTool(createUpdateCalendarEventTool(calendarClient, undoStore));
    toolRegistry.registerTool(createCreateCalendarEventTool(calendarClient, undoStore));
    toolRegistry.registerTool(createDeleteCalendarEventTool(calendarClient, undoStore));
    toolRegistry.registerTool(createUnlinkCalendarTool(calendarTokenStore));
  }
  // Registered unconditionally: reminders are always available (no
  // calendar link required), and reminder_deleted is one of the
  // undoable action types UNDO_LAST_ACTION itself already knows how to
  // reverse.
  toolRegistry.registerTool(createUndoLastActionTool(undoStore, calendarClient, reminderStore, memoryStore));

  // Shares the same Google account link as Calendar (one OAuth consent
  // screen, two scopes) rather than a second separate account link.
  const gmailClient = calendarEnabled
    ? new GmailClient(config.googleClientId!, config.googleClientSecret!, calendarTokenStore)
    : undefined;
  if (gmailClient) {
    toolRegistry.registerTool(createSearchEmailTool(gmailClient));
    toolRegistry.registerTool(createGetEmailTool(gmailClient));
    toolRegistry.registerTool(createGetUnreadEmailCountTool(gmailClient));
    toolRegistry.registerTool(createSendEmailTool(gmailClient));
    toolRegistry.registerTool(createReplyEmailTool(gmailClient));
  }

  const spotifyEnabled = Boolean(config.spotifyClientId && config.spotifyClientSecret && config.publicBaseUrl);
  const spotifyTokenStore = new SpotifyTokenStore(config.spotifyTokenDbPath);
  const spotifyClient = spotifyEnabled
    ? new SpotifyClient(
        config.spotifyClientId!,
        config.spotifyClientSecret!,
        new URL("/spotify/oauth/callback", config.publicBaseUrl).toString(),
        spotifyTokenStore
      )
    : undefined;
  if (spotifyClient) {
    toolRegistry.registerTool(createGetCurrentlyPlayingTool(spotifyClient));
    toolRegistry.registerTool(createPlayMusicTool(spotifyClient));
    toolRegistry.registerTool(createPauseMusicTool(spotifyClient));
    toolRegistry.registerTool(createSkipTrackTool(spotifyClient));
    toolRegistry.registerTool(createUnlinkSpotifyTool(spotifyTokenStore));
  }

  const studioClient =
    config.studioBaseUrl && config.studioSecret ? new StudioClient(config.studioBaseUrl, config.studioSecret) : undefined;
  if (studioClient) {
    toolRegistry.registerTool(createListReelsTool(studioClient));
    toolRegistry.registerTool(createGetInstagramStatsTool(studioClient));
    toolRegistry.registerTool(createPublishReelTool(studioClient));
  }

  const weatherEnabled = config.weatherLatitude !== undefined && config.weatherLongitude !== undefined;
  const weatherClient = weatherEnabled ? new OpenMeteoClient(config.weatherLatitude!, config.weatherLongitude!) : undefined;
  if (weatherClient) {
    toolRegistry.registerTool(createGetWeatherTool(weatherClient));
    toolRegistry.registerTool(createGetWeatherForecastTool(weatherClient));
  }

  if (config.newsRssUrl) {
    const newsClient = new RssNewsClient(config.newsRssUrl);
    toolRegistry.registerTool(createGetNewsTool(newsClient));
    toolRegistry.registerTool(createSearchNewsTool(newsClient));
  }

  toolRegistry.registerTool(readOnlyFileInfoTool);
  toolRegistry.registerTool(getActiveApplicationTool);
  toolRegistry.registerTool(listRunningApplicationsTool);
  toolRegistry.registerTool(openApplicationTool);
  toolRegistry.registerTool(quitApplicationTool);
  toolRegistry.registerTool(openUrlTool);
  toolRegistry.registerTool(listDirectoryTool);
  toolRegistry.registerTool(readTextFileTool);
  toolRegistry.registerTool(readFileBytesTool);
  toolRegistry.registerTool(listRecentPhotosTool);
  toolRegistry.registerTool(writeFileTool);
  toolRegistry.registerTool(scheduleMacNotificationTool);
  toolRegistry.registerTool(composeEmailDraftTool);
  toolRegistry.registerTool(clickElementTool);
  toolRegistry.registerTool(typeTextTool);
  toolRegistry.registerTool(setVolumeTool);
  toolRegistry.registerTool(toggleWifiTool);
  toolRegistry.registerTool(createFolderTool);
  toolRegistry.registerTool(emptyTrashTool);
  toolRegistry.registerTool(listMacRemindersTool);
  toolRegistry.registerTool(createMacReminderTool);
  toolRegistry.registerTool(completeMacReminderTool);
  toolRegistry.registerTool(createSaveMemoryTool(memoryStore));
  toolRegistry.registerTool(createSearchMemoryTool(memoryStore));
  toolRegistry.registerTool(createDeleteMemoryTool(memoryStore, undoStore));
  toolRegistry.registerTool(createCreateReminderTool(reminderStore));
  toolRegistry.registerTool(createListRemindersTool(reminderStore));
  toolRegistry.registerTool(createCompleteReminderTool(reminderStore));
  toolRegistry.registerTool(createDeleteReminderTool(reminderStore, undoStore));
  toolRegistry.registerTool(createUpdateReminderTool(reminderStore));
  toolRegistry.registerTool(createCreateAutomationRuleTool(automationRuleStore));
  toolRegistry.registerTool(createListAutomationRulesTool(automationRuleStore));
  toolRegistry.registerTool(createUpdateAutomationRuleTool(automationRuleStore));
  toolRegistry.registerTool(createDeleteAutomationRuleTool(automationRuleStore));
  toolRegistry.registerTool(createCreateCommitmentTool(commitmentStore));
  toolRegistry.registerTool(createListCommitmentsTool(commitmentStore));
  toolRegistry.registerTool(createFulfillCommitmentTool(commitmentStore));
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
  permissionService.grant(DEFAULT_USER_ID, "CREATE_AUTOMATION_RULE");
  permissionService.grant(DEFAULT_USER_ID, "UPDATE_AUTOMATION_RULE");
  permissionService.grant(DEFAULT_USER_ID, "DELETE_AUTOMATION_RULE");
  permissionService.grant(DEFAULT_USER_ID, "CREATE_COMMITMENT");
  permissionService.grant(DEFAULT_USER_ID, "FULFILL_COMMITMENT");
  // DANGEROUS: granted so the tool is askable at all, but PermissionService
  // still forces a fresh per-invocation confirmation regardless of this
  // grant — this never lets JARVIS erase the transcript silently.
  permissionService.grant(DEFAULT_USER_ID, "CLEAR_CONVERSATION_HISTORY");
  if (calendarClient) {
    permissionService.grant(DEFAULT_USER_ID, "CREATE_CALENDAR_EVENT");
    permissionService.grant(DEFAULT_USER_ID, "UPDATE_CALENDAR_EVENT");
    permissionService.grant(DEFAULT_USER_ID, "DELETE_CALENDAR_EVENT");
    // Same DANGEROUS reasoning as CLEAR_CONVERSATION_HISTORY above.
    permissionService.grant(DEFAULT_USER_ID, "UNLINK_CALENDAR");
    permissionService.grant(DEFAULT_USER_ID, "UNDO_LAST_ACTION");
  }
  if (gmailClient) {
    // CONFIRM (see SendEmailTool/ReplyEmailTool's own doc comments): the
    // grant only makes these tools askable at all — PermissionService
    // still forces a fresh per-invocation confirmation regardless, same
    // as CLEAR_CONVERSATION_HISTORY/UNLINK_CALENDAR above.
    permissionService.grant(DEFAULT_USER_ID, "SEND_EMAIL");
    permissionService.grant(DEFAULT_USER_ID, "REPLY_EMAIL");
  }
  if (spotifyClient) {
    permissionService.grant(DEFAULT_USER_ID, "PLAY_MUSIC");
    permissionService.grant(DEFAULT_USER_ID, "PAUSE_MUSIC");
    permissionService.grant(DEFAULT_USER_ID, "SKIP_TRACK");
    // Same DANGEROUS reasoning as CLEAR_CONVERSATION_HISTORY/UNLINK_CALENDAR above.
    permissionService.grant(DEFAULT_USER_ID, "UNLINK_SPOTIFY");
  }
  if (studioClient) {
    // DANGEROUS: granted so the tool is askable at all, but PermissionService
    // still forces a fresh per-invocation confirmation regardless of this
    // grant — publishing to a real public account never happens silently.
    permissionService.grant(DEFAULT_USER_ID, "PUBLISH_REEL");
  }

  const deviceRegistry = new DeviceRegistry(config.deviceRegistryDbPath);
  toolRegistry.registerTool(createListDevicesTool(deviceRegistry));

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
  const STANDARD_PRIMARY_DEVICE_TOOLS = ["OPEN_APPLICATION", "QUIT_APPLICATION", "OPEN_URL", "SCHEDULE_MAC_NOTIFICATION"];
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
  // Defense in depth: a revoked device's standing tool grants otherwise
  // stay valid forever, since nothing else ever clears them. If it ever
  // reconnected anyway (a bug elsewhere in the pairing/auth path), it
  // shouldn't silently keep acting on its old standing trust.
  eventBus.on("device.revoked", ({ deviceId }) => {
    for (const toolId of STANDARD_PRIMARY_DEVICE_TOOLS) {
      permissionService.revoke(DEFAULT_USER_ID, toolId, deviceId);
    }
  });

  const pairingService = new PairingService(undefined, undefined, config.pairingDbPath);
  const deviceConnectionManager = new DeviceConnectionManager(eventBus);
  const conversation = new ConversationManager(eventBus);
  // AIProviderRegistry holds whichever Brain(s) we could actually
  // construct from the API keys present — never require both. "groq" is
  // a genuine $0 alternative (no credit card, real tool-calling support
  // on the free tier); see GroqBrain's own doc comment and README's
  // "Free ($0) brain: Groq" section for the honest quality tradeoff.
  const aiRegistry = new AIProviderRegistry();
  if (config.groqApiKey) {
    aiRegistry.register("groq", new GroqBrain(config.groqApiKey, { model: config.groqModel }), "free");
  }
  // OpenRouter is registered as a second, independent free-tier provider
  // next to Groq — OPENROUTER_API_KEY unset simply means it's
  // unavailable, exactly like every other optional provider here, never
  // a crash and never a silent fallback to a paid one. OpenRouterBrain
  // itself refuses to construct against anything but a ":free" model
  // (see its own doc comment), so registering it as "free" here is
  // always honest regardless of ZERO_COST_MODE/budget settings.
  if (config.openrouterApiKey) {
    try {
      aiRegistry.register(
        "openrouter",
        new OpenRouterBrain(config.openrouterApiKey, { model: config.openrouterModel }),
        "free"
      );
    } catch (error) {
      if (error instanceof OpenRouterPaidModelError) {
        console.error(`[jarvis] OpenRouter provider NOT registered: ${error.message}`);
      } else {
        throw error;
      }
    }
  }
  if (config.anthropicApiKey) {
    aiRegistry.register(
      "anthropic",
      new ClaudeBrain(config.anthropicApiKey, {
        webSearchEnabled: config.webSearchEnabled,
        webSearchMaxUses: config.webSearchMaxUses,
        webFetchEnabled: config.webFetchEnabled,
        webFetchMaxUses: config.webFetchMaxUses,
        baseUrl: config.anthropicBaseUrl,
        fallbackModel: config.fallbackModel,
        promptCachingEnabled: config.promptCachingEnabled,
      }),
      "paid"
    );
  }
  const costTracker = new CostTracker(config.aiCostDbPath);
  // AIRouter is a drop-in Brain: with only one provider configured it
  // just calls that one, exactly as before. JARVIS_BRAIN_PROVIDER, when
  // explicitly set, always wins as the primary — AI_FREE_FIRST only
  // decides between providers when no explicit choice was made, so an
  // existing single-provider deployment sees no behavior change.
  const aiRouter = new AIRouter(aiRegistry, costTracker, {
    freeFirst: config.aiFreeFirst,
    explicitProvider: config.brainProviderExplicit ? config.brainProvider : undefined,
    fallbackProvider: config.aiFallbackProvider,
    maxDailyCostUsd: config.maxDailyCostUsd,
    maxMonthlyCostUsd: config.maxMonthlyCostUsd,
    zeroCostMode: config.zeroCostMode,
    circuitBreakerThreshold: config.aiCircuitBreakerThreshold,
    circuitBreakerCooldownMs: config.aiCircuitBreakerCooldownMs,
    eventBus,
  });
  // Kept as a typed AIRouter (not just the narrower Brain interface) so
  // GET /providers/health can call its getProviderStatus() — see
  // JARVIS_ROADMAP_AUDIT.md #174.
  const brain: Brain = aiRouter;
  const confirmationService = new ConfirmationService(confirmViaChat);
  const phoneConfirmationService = new ConfirmationService(denyPhoneConfirmation);
  // Shared across every channel's Orchestrator below — a repeated
  // READ-level tool call (e.g. GET_WEATHER for the same location) hits
  // this cache regardless of which channel asked first. TTL 0
  // (JARVIS_TOOL_RESULT_CACHE_TTL_MS=0) disables caching entirely; see
  // ToolResultCache's own doc comment.
  const toolResultCache = new ToolResultCache(config.toolResultCacheTtlMs);

  const orchestrator = new Orchestrator({
    brain,
    conversation,
    toolRegistry,
    permissionService,
    eventBus,
    deviceRegistry,
    deviceConnectionManager,
    confirmationService,
    contextProvider: () => buildContextNote(config, reminderStore, calendarClient, commitmentStore),
    lockdownService,
    toolResultCache,
    maxToolCallsPerRun: config.maxToolCallsPerRun,
    localToolTimeoutMs: config.localToolTimeoutMs,
    liveState: liveStateTracker,
    // Default liveStateChannel ("chat") — this is the primary web-chat/
    // terminal Orchestrator (see webChatOrchestrator below), so its
    // sessions use the plain "chat:${userId}" key.
  });

  // Autonomous Agent Core — Goal Engine + persistent/priority task queue +
  // background worker (roadmap items 26-34). Reuses the exact same
  // Orchestrator/ToolRegistry/PermissionService pipeline as any other tool
  // call; never wired into `Orchestrator.handleUserMessage` itself, an
  // explicit opt-in surface only. `resumeIncompleteTasks()` runs once,
  // synchronously, before the queue worker's first tick, so a task a
  // previous process left mid-flight (PLANNING/EXECUTING/VERIFYING/
  // RETRYING/RECOVERING/WAITING) is failed cleanly with a clear reason
  // instead of sitting there forever, invisible — see the doc comment on
  // `AgentCore.resumeIncompleteTasks` for why that's the safe default
  // rather than attempting a risky mid-tool-execution resume.
  const agentTaskStore = new AgentTaskStore(config.agentTaskDbPath);
  const agentCore = new AgentCore({
    orchestrator,
    planner: new BrainAgentPlanner(brain, toolRegistry),
    toolRegistry,
    taskStore: agentTaskStore,
    auditLog: toolAuditLog,
    eventBus,
    liveState: liveStateTracker,
  });
  const resumedTasks = agentCore.resumeIncompleteTasks();
  if (resumedTasks.length > 0) {
    console.warn(
      `[jarvis] resumeIncompleteTasks: failed ${resumedTasks.length} agent task(s) left non-terminal by a previous process (interrupted by restart)`
    );
  }
  const agentQueueInterval = setInterval(() => {
    schedulerHealthTracker.tick("agentQueue");
    agentCore.runQueueTick().catch((error) => {
      console.error("[jarvis] agent queue tick failed:", error instanceof Error ? error.message : String(error));
    });
  }, config.agentQueueTickMs);

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
      contextProvider: () => buildContextNote(config, reminderStore, calendarClient, commitmentStore),
      lockdownService,
      toolResultCache,
      maxToolCallsPerRun: config.maxToolCallsPerRun,
      localToolTimeoutMs: config.localToolTimeoutMs,
      liveState: liveStateTracker,
      liveStateChannel: "phone",
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
  const alarmStore = new AlarmStore(config.alarmDbPath);

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
      contextProvider: () => buildContextNote(config, reminderStore, calendarClient, commitmentStore),
      lockdownService,
      toolResultCache,
      maxToolCallsPerRun: config.maxToolCallsPerRun,
      localToolTimeoutMs: config.localToolTimeoutMs,
      liveState: liveStateTracker,
      liveStateChannel: "wakeup-call",
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

  // An unset/empty TWILIO_ALLOWED_CALLERS used to only log a warning and
  // start the gateway anyway — anyone who called the number reached full
  // JARVIS, including tools like SAVE_MEMORY and SEND_EMAIL (a caller can
  // self-approve its own CONFIRM prompt in the same call/chat it's
  // already talking to JARVIS through, so CONFIRM alone doesn't protect
  // against a malicious caller directly asking for one — only against
  // content the legitimate owner reads triggering one on their behalf),
  // with nothing stopping them but a server log line nobody was
  // watching. Now it refuses to start the gateway at all unless the
  // caller explicitly opts into that via TWILIO_ALLOW_OPEN_ACCESS.
  const phoneGatewayAllowlistOk =
    (config.twilioAllowedCallers && config.twilioAllowedCallers.length > 0) || config.twilioAllowOpenAccess;
  if (config.twilioAuthToken && config.twilioPublicBaseUrl && !phoneGatewayAllowlistOk) {
    console.error(
      "[jarvis] Phone gateway NOT started: TWILIO_AUTH_TOKEN/TWILIO_PUBLIC_BASE_URL are set but " +
        "TWILIO_ALLOWED_CALLERS is empty. Set TWILIO_ALLOWED_CALLERS to the E.164 numbers that may call in, " +
        "or set TWILIO_ALLOW_OPEN_ACCESS=true to intentionally accept calls from anyone."
    );
  }
  const phoneGateway =
    config.twilioAuthToken && config.twilioPublicBaseUrl && phoneGatewayAllowlistOk
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

  // A texting thread gets its own conversation, like a phone call, but
  // kept for the life of the process — same reasoning as Telegram (no
  // natural "hang up" for text). Uses the exact same ConfirmationService
  // as the phone gateway (auto-deny): see TwilioSmsGateway's own comment
  // for why a real yes/no round trip isn't possible over a webhook that
  // Twilio expects a synchronous reply to.
  function createSmsSession(_fromNumber: string): SmsSession {
    const smsConversation = new ConversationManager(eventBus);
    const smsOrchestrator = new Orchestrator({
      brain,
      conversation: smsConversation,
      toolRegistry,
      permissionService,
      eventBus,
      deviceRegistry,
      deviceConnectionManager,
      confirmationService: phoneConfirmationService,
      channelContext: "This conversation is happening over text message (SMS) right now.",
      contextProvider: () => buildContextNote(config, reminderStore, calendarClient, commitmentStore),
      lockdownService,
      toolResultCache,
      maxToolCallsPerRun: config.maxToolCallsPerRun,
      localToolTimeoutMs: config.localToolTimeoutMs,
      liveState: liveStateTracker,
      liveStateChannel: "sms",
    });
    return { orchestrator: smsOrchestrator, userId: DEFAULT_USER_ID };
  }

  // Rides the same Twilio number/credentials the phone gateway already
  // requires — no new account, number, or secret needed to turn this on.
  const smsGateway = config.twilioAuthToken && config.twilioPublicBaseUrl ? new TwilioSmsGateway(createSmsSession) : undefined;

  // A Telegram chat gets its own conversation thread, like a phone call,
  // but kept for the life of the process rather than one call's duration —
  // a chat has no natural "hang up." Scoped on purpose: JARVIS only ever
  // sees messages sent to this specific bot, in chats it's been added to.
  function createTelegramSession(chatId: string): TelegramSession {
    const telegramConversation = new ConversationManager(eventBus);
    const telegramConfirmationService = new ConfirmationService(createTelegramConfirmationPrompter(chatId));
    const telegramOrchestrator = new Orchestrator({
      brain,
      conversation: telegramConversation,
      toolRegistry,
      permissionService,
      eventBus,
      deviceRegistry,
      deviceConnectionManager,
      confirmationService: telegramConfirmationService,
      channelContext: "This conversation is happening over Telegram right now.",
      contextProvider: () => buildContextNote(config, reminderStore, calendarClient, commitmentStore),
      lockdownService,
      toolResultCache,
      maxToolCallsPerRun: config.maxToolCallsPerRun,
      localToolTimeoutMs: config.localToolTimeoutMs,
      liveState: liveStateTracker,
      liveStateChannel: "telegram",
    });
    return { orchestrator: telegramOrchestrator, userId: DEFAULT_USER_ID };
  }

  /**
   * Unlike a phone call, a Telegram chat is a reliable bidirectional text
   * channel — as capable as the terminal's own `confirmViaChat` of asking a
   * real yes/no question and waiting for a real answer. So Telegram
   * sessions get a real confirmation prompt instead of the phone's
   * auto-deny. Safe to reference `telegramGateway` here even though it's
   * declared below: this closure only runs once a Telegram message
   * actually arrives, well after `telegramGateway` has been constructed.
   */
  function createTelegramConfirmationPrompter(chatId: string) {
    return async (request: ConfirmationRequest): Promise<boolean> => {
      const inputSummary = JSON.stringify(request.input);
      return telegramGateway!.awaitConfirmation(
        chatId,
        `JARVIS wants to run "${request.toolName}" with input ${inputSummary}. Approve? (yes/no)`
      );
    };
  }

  // Same reasoning as phoneGatewayAllowlistOk above — an empty
  // TELEGRAM_ALLOWED_CHAT_IDS used to only warn, not block, leaving the
  // bot open to any chat that found and messaged it.
  const telegramGatewayAllowlistOk =
    (config.telegramAllowedChatIds && config.telegramAllowedChatIds.length > 0) || config.telegramAllowOpenAccess;
  if (config.telegramBotToken && config.telegramWebhookSecret && !telegramGatewayAllowlistOk) {
    console.error(
      "[jarvis] Telegram gateway NOT started: TELEGRAM_BOT_TOKEN/TELEGRAM_WEBHOOK_SECRET are set but " +
        "TELEGRAM_ALLOWED_CHAT_IDS is empty. Set TELEGRAM_ALLOWED_CHAT_IDS to the chat IDs that may message the " +
        "bot, or set TELEGRAM_ALLOW_OPEN_ACCESS=true to intentionally accept messages from any chat."
    );
  }
  const telegramGateway =
    config.telegramBotToken && config.telegramWebhookSecret && telegramGatewayAllowlistOk
      ? new TelegramGateway(config.telegramBotToken, createTelegramSession, config.telegramAllowedChatIds)
      : undefined;

  if (telegramGateway && config.telegramOwnerChatId) {
    toolRegistry.registerTool(createNotifyUserTool(telegramGateway, config.telegramOwnerChatId));
    permissionService.grant(DEFAULT_USER_ID, "NOTIFY_USER");
    toolRegistry.registerTool(createShareFileToPhoneTool(telegramGateway, config.telegramOwnerChatId));
    permissionService.grant(DEFAULT_USER_ID, "SHARE_FILE_TO_PHONE");
  }

  // Always registered, unlike the Telegram-only tools above — the
  // generated image's URL is useful on any channel (the tool result
  // itself always carries it); Telegram delivery on top is a bonus when
  // a owner chat happens to be configured, not a requirement.
  const pollinationsImageClient = new PollinationsImageClient();
  toolRegistry.registerTool(
    createGenerateImageTool(pollinationsImageClient, telegramGateway, config.telegramOwnerChatId)
  );
  permissionService.grant(DEFAULT_USER_ID, "GENERATE_IMAGE");

  // A paired device's "Hey JARVIS" wake-word channel gets its own
  // conversation thread, exactly like Telegram — kept for the life of the
  // process, not tied to any one utterance. Always available (no separate
  // opt-in config): it rides on the same pairing/device-trust model every
  // other device capability already requires, so there's nothing new to
  // configure here beyond the Agent actually sending voice.transcript.
  function createDeviceVoiceSession(deviceId: string): DeviceVoiceSession {
    const voiceConversation = new ConversationManager(eventBus);
    const voiceConfirmationService = new ConfirmationService(createDeviceVoiceConfirmationPrompter(deviceId));
    const voiceOrchestrator = new Orchestrator({
      brain,
      conversation: voiceConversation,
      toolRegistry,
      permissionService,
      eventBus,
      deviceRegistry,
      deviceConnectionManager,
      confirmationService: voiceConfirmationService,
      channelContext: "This conversation is happening by voice, right now, on the user's Mac.",
      contextProvider: () => buildContextNote(config, reminderStore, calendarClient, commitmentStore),
      lockdownService,
      toolResultCache,
      maxToolCallsPerRun: config.maxToolCallsPerRun,
      localToolTimeoutMs: config.localToolTimeoutMs,
      liveState: liveStateTracker,
      liveStateChannel: "device-voice",
    });
    return { orchestrator: voiceOrchestrator, userId: DEFAULT_USER_ID };
  }

  /** Same reasoning as createTelegramConfirmationPrompter: a paired device is a reliable bidirectional channel. */
  function createDeviceVoiceConfirmationPrompter(deviceId: string) {
    return async (request: ConfirmationRequest): Promise<boolean> => {
      const inputSummary = JSON.stringify(request.input);
      return deviceVoiceGateway!.awaitConfirmation(
        deviceId,
        `JARVIS wants to run "${request.toolName}" with input ${inputSummary}. Say yes or no.`
      );
    };
  }

  const deviceVoiceGateway = new DeviceVoiceGateway(deviceConnectionManager, createDeviceVoiceSession);

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

    // Same account/credentials as outboundCaller above — reuses the same
    // "outbound call" config group since SMS needs exactly the same
    // Twilio fields (account sid, auth token, from number) plus somewhere
    // to send to (ownerPhoneNumber).
    const smsSender = new TwilioSmsSender(config.twilioAccountSid!, config.twilioAuthToken!, config.twilioFromNumber!);
    toolRegistry.registerTool(createSendSmsTool(smsSender, config.ownerPhoneNumber!));
    permissionService.grant(DEFAULT_USER_ID, "SEND_SMS");

    // WakeUpCallStore's lastTriggeredDate check makes each tick idempotent
    // ONCE a call has actually completed — but a call stays due for up to
    // two ticks within the same matching minute (checks run every 30s),
    // so a placeCall() that's still in flight when the next tick fires
    // (a slow/stuck network request) would otherwise be dialed again
    // before markTriggered() ever runs. inFlightWakeUpCallIds closes that
    // gap: a call id is tracked as soon as placeCall() starts, not only
    // once it resolves.
    const inFlightWakeUpCallIds = new Set<string>();
    // Twilio Cost Guard: bounds how many real, billed outbound calls JARVIS
    // will place in a day, independent of how many wake-up call rules
    // exist or how the scheduler's own idempotency logic behaves — see
    // TwilioCostGuard's own doc comment.
    const outboundCallCostGuard = new TwilioCostGuard(config.maxOutboundCallsPerDay);

    wakeUpInterval = setInterval(() => {
      schedulerHealthTracker.tick("wakeUpCalls");
      const now = new Date();
      const nowTimeOfDay = formatTimeOfDay(now, config.timezone);
      const todayDateStr = formatDateKey(now, config.timezone);
      const due = getDueWakeUpCalls(wakeUpCallStore.list(), nowTimeOfDay, todayDateStr, inFlightWakeUpCallIds);

      for (const call of due) {
        if (!outboundCallCostGuard.tryConsume(todayDateStr)) {
          // Marked triggered (not left due) even though no call went out —
          // otherwise this would just hit the same cap again every tick
          // for the rest of the day, spamming the log/activity feed for a
          // call that was never going to be allowed through anyway.
          wakeUpCallStore.markTriggered(call.id, todayDateStr);
          const message = `JARVIS skipped your wake-up call${call.label ? ` (${call.label})` : ""}: today's outbound call limit (${config.maxOutboundCallsPerDay}) was already reached.`;
          console.error(`[jarvis] ${message}`);
          activityLog.record(message);
          if (telegramGateway && config.telegramOwnerChatId) {
            telegramGateway.sendMessage(config.telegramOwnerChatId, message).catch(() => {});
          }
          continue;
        }

        inFlightWakeUpCallIds.add(call.id);
        outboundCaller
          .placeCall(config.ownerPhoneNumber!, wakeUpTwimlUrl)
          .then(() => {
            wakeUpCallStore.markTriggered(call.id, todayDateStr);
            activityLog.record(`Placed wake-up call${call.label ? ` (${call.label})` : ""}`);
          })
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[jarvis] failed to place wake-up call ${call.id}:`, message);
            activityLog.record(`Failed to place wake-up call${call.label ? ` (${call.label})` : ""}: ${message}`);
            // A failed alarm call is silent by nature — the one thing it
            // can't do is tell the user it didn't ring. If a Telegram
            // push channel is configured, use it as the one channel that
            // doesn't depend on the phone call that just failed.
            if (telegramGateway && config.telegramOwnerChatId) {
              telegramGateway
                .sendMessage(
                  config.telegramOwnerChatId,
                  `JARVIS failed to place your wake-up call${call.label ? ` (${call.label})` : ""}: ${message}`
                )
                .catch(() => {
                  // Best-effort notification about a best-effort call — already logged above either way.
                });
            }
          })
          .finally(() => {
            inFlightWakeUpCallIds.delete(call.id);
          });
      }
    }, 30_000);
  }

  let alarmInterval: ReturnType<typeof setInterval> | undefined;
  const alarmsEnabled = Boolean(telegramGateway && config.telegramOwnerChatId);
  if (alarmsEnabled) {
    toolRegistry.registerTool(createCreateAlarmTool(alarmStore));
    toolRegistry.registerTool(createListAlarmsTool(alarmStore));
    toolRegistry.registerTool(createUpdateAlarmTool(alarmStore));
    toolRegistry.registerTool(createDeleteAlarmTool(alarmStore));
    permissionService.grant(DEFAULT_USER_ID, "CREATE_ALARM");
    permissionService.grant(DEFAULT_USER_ID, "UPDATE_ALARM");
    permissionService.grant(DEFAULT_USER_ID, "DELETE_ALARM");

    // Same in-flight-tracking reasoning as inFlightWakeUpCallIds above —
    // a slow Telegram send shouldn't get double-fired by the next tick.
    const inFlightAlarmIds = new Set<string>();

    alarmInterval = setInterval(() => {
      schedulerHealthTracker.tick("alarms");
      const now = new Date();
      const nowTimeOfDay = formatTimeOfDay(now, config.timezone);
      const todayDateStr = formatDateKey(now, config.timezone);
      const due = getDueAlarms(alarmStore.list(), nowTimeOfDay, todayDateStr, inFlightAlarmIds);

      for (const alarm of due) {
        inFlightAlarmIds.add(alarm.id);
        telegramGateway!
          .sendMessage(config.telegramOwnerChatId!, `⏰ Alarm${alarm.label ? ` — ${alarm.label}` : ""}`)
          .then(() => {
            alarmStore.markTriggered(alarm.id, todayDateStr);
            activityLog.record(`Alarm fired${alarm.label ? ` (${alarm.label})` : ""}`);
          })
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[jarvis] failed to fire alarm ${alarm.id}:`, message);
            activityLog.record(`Failed to fire alarm${alarm.label ? ` (${alarm.label})` : ""}: ${message}`);
          })
          .finally(() => {
            inFlightAlarmIds.delete(alarm.id);
          });
      }
    }, 30_000);
  }

  let weeklyDigestInterval: ReturnType<typeof setInterval> | undefined;
  const weeklyDigestEnabled = Boolean(
    config.weeklyDigestDayOfWeek !== undefined &&
      config.weeklyDigestTime &&
      telegramGateway &&
      config.telegramOwnerChatId
  );
  if (weeklyDigestEnabled) {
    let lastWeeklyDigestDateKey: string | null = null;
    weeklyDigestInterval = setInterval(() => {
      schedulerHealthTracker.tick("weeklyDigest");
      const now = new Date();
      const nowTimeOfDay = formatTimeOfDay(now, config.timezone);
      const todayDateKey = formatDateKey(now, config.timezone);

      if (
        !isWeeklyDigestDue(
          now,
          config.timezone,
          config.weeklyDigestDayOfWeek!,
          config.weeklyDigestTime!,
          nowTimeOfDay,
          todayDateKey,
          lastWeeklyDigestDateKey
        )
      ) {
        return;
      }

      lastWeeklyDigestDateKey = todayDateKey;
      const cost = estimateCostUsd(tokenUsageStore.totals(), DEFAULT_MODEL);
      const message = formatWeeklyDigest(toolAuditLog.summary(), tokenUsageStore.totals(), cost);
      telegramGateway!.sendMessage(config.telegramOwnerChatId!, message).catch((error) => {
        console.error("[jarvis] failed to send weekly digest:", error instanceof Error ? error.message : String(error));
      });
    }, 30_000);
  }

  let checkinInterval: ReturnType<typeof setInterval> | undefined;
  const checkinEnabled = Boolean(config.checkinAfterHours && telegramGateway && config.telegramOwnerChatId);
  if (checkinEnabled) {
    let lastInteractionAt = new Date();
    let checkinSentSinceLastInteraction = false;
    eventBus.on("brain.request", () => {
      lastInteractionAt = new Date();
      checkinSentSinceLastInteraction = false;
    });

    checkinInterval = setInterval(() => {
      schedulerHealthTracker.tick("checkin");
      if (!isCheckinDue(new Date(), lastInteractionAt, config.checkinAfterHours!, checkinSentSinceLastInteraction)) {
        return;
      }

      checkinSentSinceLastInteraction = true;
      const hours = Math.round((Date.now() - lastInteractionAt.getTime()) / 3_600_000);
      const message = `Haven't heard from you in about ${hours} hours — just checking in.`;
      telegramGateway!.sendMessage(config.telegramOwnerChatId!, message).catch((error) => {
        console.error("[jarvis] failed to send check-in:", error instanceof Error ? error.message : String(error));
      });
    }, 60_000);
  }

  let morningBriefingInterval: ReturnType<typeof setInterval> | undefined;
  const morningBriefingEnabled = Boolean(config.morningBriefingTime && telegramGateway && config.telegramOwnerChatId);
  if (morningBriefingEnabled) {
    let lastMorningBriefingDateKey: string | null = null;
    // Set when the briefing became due while quiet hours were active —
    // held here instead of being sent (or dropped) immediately, and
    // flushed by the very next tick once quiet hours end, same calendar
    // day. `lastMorningBriefingDateKey` is still set the moment it
    // becomes due (not when it's actually sent), so isMorningBriefingDue
    // never re-captures it a second time that day.
    let pendingMorningBriefingDateKey: string | null = null;

    async function sendMorningBriefing(now: Date): Promise<void> {
      const weather = await weatherClient?.getCurrentWeather().catch(() => undefined);
      const todaysEvents = calendarClient ? await calendarClient.listUpcomingEvents(10).catch(() => []) : [];
      const nowIso = now.toISOString();
      const dueOrOverdueReminders = reminderStore.list().filter((r) => r.dueAt !== null && r.dueAt <= nowIso);

      const message = formatMorningBriefing(weather, todaysEvents, dueOrOverdueReminders);
      telegramGateway!.sendMessage(config.telegramOwnerChatId!, message).catch((error) => {
        console.error(
          "[jarvis] failed to send morning briefing:",
          error instanceof Error ? error.message : String(error)
        );
      });
    }

    morningBriefingInterval = setInterval(async () => {
      schedulerHealthTracker.tick("morningBriefing");
      const now = new Date();
      const nowTimeOfDay = formatTimeOfDay(now, config.timezone);
      const todayDateKey = formatDateKey(now, config.timezone);
      const quiet = isSuppressibleByQuietHours("morning_briefing") && isQuietHours(nowTimeOfDay, quietHoursWindow);

      if (isMorningBriefingDue(config.morningBriefingTime!, nowTimeOfDay, todayDateKey, lastMorningBriefingDateKey)) {
        lastMorningBriefingDateKey = todayDateKey;
        if (quiet) {
          // Queued: nothing sent now, but flushed below the first time a
          // later tick lands outside the quiet-hours window.
          pendingMorningBriefingDateKey = todayDateKey;
        } else {
          await sendMorningBriefing(now);
        }
        return;
      }

      if (pendingMorningBriefingDateKey === todayDateKey && !quiet) {
        pendingMorningBriefingDateKey = null;
        await sendMorningBriefing(now);
      }
    }, 30_000);
  }

  // Proactive automation: JARVIS acting on its own by a schedule the user
  // defined, rather than only in response to a message. Each rule's
  // instruction is run through the same shared `orchestrator` the
  // CLI/hologram chat uses — every normal tool-permission check still
  // applies, this only automates *starting* the turn. Same in-flight-set
  // pattern as the wake-up call scheduler above, for the same reason: a
  // slow turn still running when the next tick fires shouldn't trigger
  // the same rule twice.
  //
  // Quiet hours applies only to the *result push* (the Telegram message
  // telling the user what the rule did), not to running the rule itself —
  // a rule might do real, time-sensitive work regardless of the hour. A
  // push suppressed by quiet hours is queued here (not dropped) and
  // flushed by the first tick once the window ends.
  const inFlightAutomationRuleIds = new Set<string>();
  const pendingQuietAutomationPushes: string[] = [];
  const automationRuleInterval = setInterval(() => {
    schedulerHealthTracker.tick("automationRules");
    const now = new Date();
    const nowTimeOfDay = formatTimeOfDay(now, config.timezone);
    const todayDateKey = formatDateKey(now, config.timezone);
    const quiet = isSuppressibleByQuietHours("automation_rule_result") && isQuietHours(nowTimeOfDay, quietHoursWindow);

    if (!quiet && pendingQuietAutomationPushes.length > 0 && telegramGateway && config.telegramOwnerChatId) {
      for (const queuedMessage of pendingQuietAutomationPushes.splice(0)) {
        if (notificationDedup.shouldSend(`automation-push:${queuedMessage}`)) {
          telegramGateway.sendMessage(config.telegramOwnerChatId, queuedMessage).catch(() => {
            // Best-effort push — already logged when the rule ran.
          });
        }
      }
    }

    const due = getDueAutomationRules(automationRuleStore.list(), nowTimeOfDay, todayDateKey, inFlightAutomationRuleIds);

    for (const rule of due) {
      inFlightAutomationRuleIds.add(rule.id);
      orchestrator
        .handleUserMessage(DEFAULT_USER_ID, rule.instruction)
        .then((reply) => {
          automationRuleStore.markTriggered(rule.id, todayDateKey);
          activityLog.record(`Automation ran: ${rule.instruction.slice(0, 100)}`);
          if (telegramGateway && config.telegramOwnerChatId) {
            if (isSuppressibleByQuietHours("automation_rule_result") && isQuietHours(formatTimeOfDay(new Date(), config.timezone), quietHoursWindow)) {
              pendingQuietAutomationPushes.push(reply);
            } else if (notificationDedup.shouldSend(`automation-push:${reply}`)) {
              telegramGateway!.sendMessage(config.telegramOwnerChatId!, reply).catch(() => {
                // Best-effort push — the rule still ran and is logged above either way.
              });
            }
          }
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[jarvis] automation rule ${rule.id} failed:`, message);
          activityLog.record(`Automation failed: ${rule.instruction.slice(0, 100)} — ${message}`);
          // A durable failure record (survives restart/redeploy, unlike
          // the console line and ActivityLog entry above) plus a
          // best-effort user-facing push — see JARVIS_ROADMAP_AUDIT.md
          // #177/#178, and the same "best-effort push, never let a
          // notification failure crash the scheduler" pattern the
          // wake-up-call scheduler already uses above.
          const errorId = logger.withCorrelationId(rule.id).error("automation_rule_failed", {
            ruleId: rule.id,
            message,
          });
          automationFailureStore.record(rule.id, rule.instruction, message);
          if (telegramGateway && config.telegramOwnerChatId) {
            telegramGateway!
              .sendMessage(
                config.telegramOwnerChatId!,
                `⚠️ Automation rule failed (errorId ${errorId}): ${rule.instruction.slice(0, 100)} — ${message}`
              )
              .catch(() => {
                // Best-effort notification about a best-effort rule — already recorded above either way.
              });
          }
        })
        .finally(() => {
          inFlightAutomationRuleIds.delete(rule.id);
        });
    }
  }, 30_000);

  // Reminder due-notifications: "remind me in an hour" previously only
  // ever surfaced if the user happened to talk to JARVIS again after the
  // time passed (dueRemindersNote is only injected as per-turn context).
  // This tick actually pushes a notification the moment a reminder comes
  // due, the same way NOTIFY_USER/automation rules reach the user without
  // them asking first. `notifiedAt` (persisted, not in-memory) makes this
  // safe across restarts: a reminder already notified stays that way, and
  // one edited to a new due date (ReminderStore.update clears notifiedAt)
  // is treated as due again.
  //
  // Quiet hours: a due-but-unnotified reminder found during quiet hours is
  // simply left alone (markNotified is only called outside the window) —
  // getDueUnnotified keeps returning it on every tick until a tick lands
  // outside the window, which is exactly "queued to fire at the window's
  // end" without needing a separate queue/timer of its own. Reminders are
  // deliberately one of the notification types quiet hours DOES apply to
  // (see JarvisConfig.quietHoursStart's own doc comment for which types
  // opt out instead).
  const reminderNotificationInterval = setInterval(() => {
    schedulerHealthTracker.tick("reminderNotifications");
    const now = new Date();
    const nowIso = now.toISOString();
    if (isSuppressibleByQuietHours("reminder") && isQuietHours(formatTimeOfDay(now, config.timezone), quietHoursWindow)) return;
    const due = reminderStore.getDueUnnotified(nowIso);

    for (const reminder of due) {
      reminderStore.markNotified(reminder.id, nowIso);
      const message = `⏰ Reminder: ${reminder.text}`;
      activityLog.record(`Reminder notification sent: ${reminder.text.slice(0, 100)}`);
      if (telegramGateway && config.telegramOwnerChatId) {
        telegramGateway.sendMessage(config.telegramOwnerChatId, message).catch((error) => {
          console.error(
            "[jarvis] failed to send reminder notification:",
            error instanceof Error ? error.message : String(error)
          );
        });
      }
      // Native on-device push, independent of Telegram being configured
      // at all — a paired Mac already has everything this needs, no
      // separate bot/account setup required.
      const primaryDevice = deviceRegistry.getPrimaryDevice();
      if (primaryDevice) {
        deviceConnectionManager.sendNotification(primaryDevice.id, "JARVIS Reminder", reminder.text);
      }
    }
  }, 30_000);

  // Follow-up engine / stale-commitment detection: same setInterval +
  // in-flight-id-set pattern as the schedulers above, but this tick
  // doesn't push anything itself — it only transitions an open
  // commitment to "stale" once it's been open longer than
  // JARVIS_STALE_COMMITMENT_DAYS (getStaleCommitments/markStale). The
  // actual surfacing to the user happens via staleCommitmentsNote inside
  // buildContextNote, the same proactive-context-injection mechanism
  // dueRemindersNote already uses for overdue reminders — deliberately
  // NOT a second notification channel (see CommitmentStore's own doc
  // comment and JARVIS_ROADMAP_AUDIT.md #128/#129).
  const staleCommitmentThresholdMs = config.staleCommitmentDays * 24 * 60 * 60 * 1000;
  const inFlightStaleCommitmentIds = new Set<string>();
  const staleCommitmentInterval = setInterval(() => {
    const nowIso = new Date().toISOString();
    const stale = getStaleCommitments(
      commitmentStore.list("open"),
      staleCommitmentThresholdMs,
      nowIso,
      inFlightStaleCommitmentIds
    );

    for (const commitment of stale) {
      inFlightStaleCommitmentIds.add(commitment.id);
      try {
        commitmentStore.markStale(commitment.id);
        activityLog.record(`Commitment went stale: ${commitment.text.slice(0, 100)}`);
      } finally {
        inFlightStaleCommitmentIds.delete(commitment.id);
      }
    }
  }, 30_000);

  const wsServer = new JarvisWebSocketServer({
    deviceRegistry,
    deviceConnectionManager,
    pairingService,
    eventBus,
    toolRegistry,
    activityLog,
    phoneGateway,
    smsGateway,
    twilioAuthToken: config.twilioAuthToken,
    twilioPublicBaseUrl: config.twilioPublicBaseUrl,
    twilioAllowedCallers: config.twilioAllowedCallers,
    telegramGateway,
    deviceVoiceGateway,
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
    spotifyClient,
    wakeUpCallStore,
    aiRouter,
    schedulerHealthTracker,
    automationFailureStore,
    // Admin panel (ui/admin/) read endpoints — see
    // JARVIS_ROADMAP_AUDIT.md #205/#208. Purely additive: neither route
    // did anything before this existed, and every other consumer of
    // `permissionService`/`config` above is unaffected.
    permissionServiceForAdmin: permissionService,
    jarvisConfig: config,
    // Command Center (ui/command-center/) read endpoints — see
    // JARVIS_ROADMAP_AUDIT.md #186/#187/#189/#190/#192/#195/#196. Purely
    // additive, same pattern as the admin-panel deps just above: every
    // route these enable 404s without them, so nothing existing changes.
    automationRuleStoreForAdmin: automationRuleStore,
    costTrackerForAdmin: costTracker,
    liveStateTracker,
    dataDirectory: config.memoryDbPath === ":memory:" ? undefined : dirname(config.memoryDbPath),
    backupDbPaths: [
      config.memoryDbPath,
      config.webauthnDbPath,
      config.remindersDbPath,
      config.commitmentsDbPath,
      config.activityLogDbPath,
      config.conversationHistoryDbPath,
      config.pairingDbPath,
      config.deviceRegistryDbPath,
      config.toolAuditLogDbPath,
      config.tokenUsageDbPath,
      config.wakeUpCallDbPath,
      config.calendarTokenDbPath,
      config.automationFailuresDbPath,
    ],
    permissionService,
    defaultUserId: DEFAULT_USER_ID,
    // The hologram UI's real chat box (ws(s)://.../chat) shares this same
    // primary orchestrator/conversation — the exact one the CLI loop below
    // drives — rather than a separate instance, so "talk to Jarvis from
    // the browser" and "talk to Jarvis from this terminal" are the same
    // ongoing conversation, not two Jarvises with separate memory of it.
    webChatOrchestrator: orchestrator,
    // Approving a device's pairing is the one explicit, deliberate human
    // decision this system already has to trust a specific device with —
    // these are the SAFE_ACTION/CONFIRM device tools that would otherwise
    // be permanently ungrantable (see JarvisWebSocketServerDependencies'
    // own doc comment on this field for why). CONFIRM tools still ask
    // per-invocation regardless (confirmViaChat below) — a grant here
    // only means "may be asked," never "runs without asking."
    autoGrantToolIdsOnApproval: [
      "OPEN_URL",
      "OPEN_APPLICATION",
      "COMPOSE_EMAIL_DRAFT",
      "CLICK_ELEMENT",
      "TYPE_TEXT",
      "SET_VOLUME",
      "TOGGLE_WIFI",
      "CREATE_FOLDER",
      "EMPTY_TRASH",
      "LIST_MAC_REMINDERS",
      "CREATE_MAC_REMINDER",
      "COMPLETE_MAC_REMINDER",
    ],
  });
  wsServerRef = wsServer;
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
  console.log(
    smsGateway
      ? "SMS gateway: enabled (POST /sms/incoming) — same Twilio number as the phone gateway"
      : "SMS gateway: disabled (rides the phone gateway's own config — set TWILIO_AUTH_TOKEN and TWILIO_PUBLIC_BASE_URL to enable both)"
  );
  if (audioLevelBroadcaster) {
    console.log("Audio waveform: enabled (Twilio Media Streams — extra cost ~$0.004/min on the Twilio account)");
  }
  // Only reachable via the explicit TWILIO_ALLOW_OPEN_ACCESS opt-in now —
  // an empty allowlist with no opt-in never gets this far (see
  // phoneGatewayAllowlistOk above), so this is a reminder of a choice
  // already made, not a warning about an accidental gap.
  if (phoneGateway && (!config.twilioAllowedCallers || config.twilioAllowedCallers.length === 0)) {
    console.warn(
      "[jarvis] WARNING: phone gateway is running open (TWILIO_ALLOW_OPEN_ACCESS=true, no " +
        "TWILIO_ALLOWED_CALLERS) — anyone who calls the configured number reaches full JARVIS, " +
        "including tools like SAVE_MEMORY and SEND_EMAIL."
    );
  }
  console.log(
    telegramGateway
      ? "Telegram gateway: enabled (POST /telegram/webhook)"
      : "Telegram gateway: disabled (set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET to enable)"
  );
  // Only reachable via the explicit TELEGRAM_ALLOW_OPEN_ACCESS opt-in now
  // — see the phone gateway comment above.
  if (telegramGateway && (!config.telegramAllowedChatIds || config.telegramAllowedChatIds.length === 0)) {
    console.warn(
      "[jarvis] WARNING: Telegram gateway is running open (TELEGRAM_ALLOW_OPEN_ACCESS=true, no " +
        "TELEGRAM_ALLOWED_CHAT_IDS) — anyone who finds and messages the bot reaches full JARVIS, " +
        "including tools like SAVE_MEMORY and SEND_EMAIL."
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
    automationRuleStore.close();
    automationFailureStore.close();
    commitmentStore.close();
    if (staleCommitmentInterval) clearInterval(staleCommitmentInterval);
    conversationHistoryStore.close();
    activityLog.close();
    toolAuditLog.close();
    tokenUsageStore.close();
    costTracker.close();
    deviceRegistry.close();
    pairingService.close();
    webAuthnStore.close();
    wakeUpCallStore.close();
    if (wakeUpInterval) clearInterval(wakeUpInterval);
    alarmStore.close();
    if (alarmInterval) clearInterval(alarmInterval);
    if (weeklyDigestInterval) clearInterval(weeklyDigestInterval);
    if (checkinInterval) clearInterval(checkinInterval);
    if (morningBriefingInterval) clearInterval(morningBriefingInterval);
    clearInterval(reminderNotificationInterval);
    clearInterval(automationRuleInterval);
    clearInterval(agentQueueInterval);
    agentTaskStore.close();
    calendarTokenStore.close();
    spotifyTokenStore.close();
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
    smsGateway,
    telegramGateway,
    eventBus,
  };
}

// Set once wsServer exists, below — confirmViaChat is only ever actually
// CALLED later, asynchronously, once a real CONFIRM/DANGEROUS tool call
// happens well after startup finishes, the same forward-reference
// reasoning already used for telegramGateway! elsewhere in this file.
let wsServerRef: JarvisWebSocketServer | undefined;

/**
 * Asks the human for a CONFIRM/DANGEROUS tool call's approval, over
 * whichever of the terminal/hologram-chat channels is actually live right
 * now — the terminal and the browser share one Orchestrator/
 * ConversationManager (see webChatOrchestrator below) precisely so
 * talking to JARVIS from either feels like the same ongoing conversation,
 * so the confirmation prompt has to follow that same "one conversation"
 * model rather than being pinned to the terminal alone. Found and fixed
 * during a later security review: SEND_EMAIL/REPLY_EMAIL (and the
 * pre-existing CLICK_ELEMENT/TYPE_TEXT) are CONFIRM-level, but a browser
 * user calling one of them via the hologram chat used to get this same
 * prompt silently routed to the SERVER's own terminal stdin — invisible
 * and unanswerable from the browser, so the request just timed out and
 * denied itself 60 seconds later with no visible reason. Now: if a
 * browser is actually connected to /chat, ask there instead (real
 * yes/no over the socket, see JarvisWebSocketServer.requestWebChatConfirmation);
 * otherwise fall back to the terminal, unchanged from before.
 */
async function confirmViaChat(request: ConfirmationRequest): Promise<boolean> {
  const inputSummary = JSON.stringify(request.input);
  const questionText = `JARVIS wants to run "${request.toolName}" with input ${inputSummary}. Approve? (yes/no)`;

  if (wsServerRef?.hasWebChatConnection) {
    return wsServerRef.requestWebChatConfirmation(questionText);
  }

  const answer = await rl.question(`\n⚠️  ${questionText}: `);
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
