import { createInterface } from "node:readline/promises";
import { dirname } from "node:path";
import { loadConfig } from "@/config";
import { EventBus } from "@/core/events/EventBus";
import { JarvisLiveStateTracker } from "@/core/state/JarvisLiveState";
import { ConversationManager } from "@/core/conversation/ConversationManager";
import { ClaudeBrain, DEFAULT_MODEL } from "@/core/brain/ClaudeBrain";
import { GroqBrain } from "@/core/brain/GroqBrain";
import { OpenRouterBrain, OpenRouterPaidModelError } from "@/core/brain/OpenRouterBrain";
import { OllamaBrain } from "@/core/brain/OllamaBrain";
import { CloudflareWorkersAIBrain } from "@/core/brain/CloudflareWorkersAIBrain";
import { GeminiBrain } from "@/core/brain/GeminiBrain";
import { AIProviderRegistry } from "@/core/brain/AIProviderRegistry";
import { AIRouter } from "@/core/brain/AIRouter";
import { CostTracker } from "@/core/cost/CostTracker";
import type { Brain } from "@/types/brain";
import { Orchestrator } from "@/core/orchestrator/Orchestrator";
import { ToolResultCache } from "@/core/cache/ToolResultCache";
import { OllamaEmbeddingsClient } from "@/core/embeddings/OllamaEmbeddingsClient";
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
import { captureScreenshotTool } from "@/tools/system/CaptureScreenshotTool";
import { lookAtScreenTool } from "@/tools/system/LookAtScreenTool";
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
import { MemoryExtractor } from "@/memory/MemoryExtractor";
import { ReminderStore } from "@/reminders/ReminderStore";
import { buildContextNote } from "@/core/buildContextNote";
import { ToolAuditLog } from "@/audit/ToolAuditLog";
import { AgentCore } from "@/agent/AgentCore";
import { AgentTaskStore } from "@/agent/AgentTaskStore";
import { GoalStore } from "@/agent/GoalStore";
import { BrainAgentPlanner } from "@/agent/BrainAgentPlanner";
import { createCreateGoalTool } from "@/tools/agent/CreateGoalTool";
import { createCheckGoalProgressTool } from "@/tools/agent/CheckGoalProgressTool";
import { createCompleteGoalTool } from "@/tools/agent/CompleteGoalTool";
import { createCancelGoalTool } from "@/tools/agent/CancelGoalTool";
import { TokenUsageStore } from "@/audit/TokenUsageStore";
import { CostAlertMonitor } from "@/audit/CostAlertMonitor";
import { estimateCostUsd } from "@/audit/estimateCostUsd";
import { createCreateReminderTool } from "@/tools/reminders/CreateReminderTool";
import { createListRemindersTool } from "@/tools/reminders/ListRemindersTool";
import { createCompleteReminderTool } from "@/tools/reminders/CompleteReminderTool";
import { createDeleteReminderTool } from "@/tools/reminders/DeleteReminderTool";
import { createUpdateReminderTool } from "@/tools/reminders/UpdateReminderTool";
import { composeAnnouncementText } from "@/reminders/composeAnnouncementText";
import { getAnnounceFollowUps } from "@/reminders/getAnnounceFollowUps";
import { resolveAnnounceTargets } from "@/reminders/resolveAnnounceTargets";
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
import { BehaviorCorrectionStore } from "@/behavior/BehaviorCorrectionStore";
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
import { createListLinkedGoogleAccountsTool } from "@/tools/calendar/ListLinkedGoogleAccountsTool";
import { createCreateCalendarEventTool } from "@/tools/calendar/CreateCalendarEventTool";
import { createDeleteCalendarEventTool } from "@/tools/calendar/DeleteCalendarEventTool";
import { UndoStore } from "@/core/undo/UndoStore";
import { createUndoLastActionTool } from "@/tools/undo/UndoLastActionTool";
import { GmailClient } from "@/gmail/GmailClient";
import { GoogleDriveClient } from "@/drive/GoogleDriveClient";
import { GoogleSlidesClient } from "@/drive/GoogleSlidesClient";
import { GoogleDocsClient } from "@/drive/GoogleDocsClient";
import { createCreatePresentationTool } from "@/tools/drive/CreatePresentationTool";
import { createCreateChecklistTool } from "@/tools/drive/CreateChecklistTool";
import { createCreateDocumentTool } from "@/tools/drive/CreateDocumentTool";
import { createFindDriveFileTool } from "@/tools/drive/FindDriveFileTool";
import { createSearchDriveFilesTool } from "@/tools/drive/SearchDriveFilesTool";
import { YouTubeClient } from "@/youtube/YouTubeClient";
import { createGetMyYouTubeChannelTool } from "@/tools/youtube/GetMyYouTubeChannelTool";
import { createListMyYouTubeVideosTool } from "@/tools/youtube/ListMyYouTubeVideosTool";
import { createGetYouTubeVideoStatsTool } from "@/tools/youtube/GetYouTubeVideoStatsTool";
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
import { CanvaClient } from "@/canva/CanvaClient";
import { CanvaTokenStore } from "@/canva/CanvaTokenStore";
import { createListCanvaDesignsTool } from "@/tools/canva/ListCanvaDesignsTool";
import { createListCanvaBrandTemplatesTool } from "@/tools/canva/ListCanvaBrandTemplatesTool";
import { createCreateCanvaDesignTool } from "@/tools/canva/CreateCanvaDesignTool";
import { createExportCanvaDesignTool } from "@/tools/canva/ExportCanvaDesignTool";
import { GitHubClient } from "@/github/GitHubClient";
import { createListGitHubCommitsTool } from "@/tools/github/ListGitHubCommitsTool";
import { createListGitHubIssuesTool } from "@/tools/github/ListGitHubIssuesTool";
import { createListGitHubPullRequestsTool } from "@/tools/github/ListGitHubPullRequestsTool";
import { createCheckGitHubRepoActivityTool } from "@/tools/github/CheckGitHubRepoActivityTool";
import { createCommentOnGitHubIssueTool } from "@/tools/github/CommentOnGitHubIssueTool";
import { createMergeGitHubPullRequestTool } from "@/tools/github/MergeGitHubPullRequestTool";
import { GitHubActivityStore } from "@/github/GitHubActivityStore";
import { pollGitHubActivity, resolveWatchedRepos } from "@/github/pollGitHubActivity";
import { githubActivityNote, formatRepoActivitySummary } from "@/github/githubActivityNote";
import { createSearchEmailTool } from "@/tools/gmail/SearchEmailTool";
import { createSendEmailTool } from "@/tools/gmail/SendEmailTool";
import { createReplyEmailTool } from "@/tools/gmail/ReplyEmailTool";
import { createGetEmailTool } from "@/tools/gmail/GetEmailTool";
import { createGetUnreadEmailCountTool } from "@/tools/gmail/GetUnreadEmailCountTool";
import { AgentMailClient } from "@/agentmail/AgentMailClient";
import { AgentMailSendGuard } from "@/agentmail/AgentMailSendGuard";
import { createSendAgentEmailTool } from "@/tools/agentmail/SendAgentEmailTool";
import { createCheckAgentInboxTool } from "@/tools/agentmail/CheckAgentInboxTool";
import { OpenMeteoClient } from "@/weather/OpenMeteoClient";
import { createGetWeatherTool } from "@/tools/weather/GetWeatherTool";
import { createGetWeatherForecastTool } from "@/tools/weather/GetWeatherForecastTool";
import { RssNewsClient } from "@/news/RssNewsClient";
import { createNewsWatchSources } from "@/news/newsWatchSources";
import { createGmailWatchSources } from "@/gmail/gmailWatchSource";
import type { EmailSummary } from "@/types/gmail";
import { WatcherStore } from "@/watcher/WatcherStore";
import { pollWatchSources } from "@/watcher/pollWatchSources";
import { createPollScheduler } from "@/watcher/scheduler";
import { WatcherNotifier } from "@/watcher/WatcherNotifier";
import { emptyWatcherChannelConfig } from "@/watcher/WatcherChannelRouter";
import { createSelfImprovementWatchSource, SELF_IMPROVEMENT_SOURCE_ID } from "@/watcher/selfImprovementWatchSource";
import { selfImprovementNote } from "@/watcher/selfImprovementNote";
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
import { ProactiveAnnouncer } from "@/communication/voice/ProactiveAnnouncer";
import { ConfirmationPassphraseStore } from "@/security/ConfirmationPassphraseStore";
import { PassphraseSpeakerAuthenticator } from "@/core/confirmation/SpeakerAuthenticator";
import { createSetConfirmationPassphraseTool } from "@/tools/security/SetConfirmationPassphraseTool";
import { createNotifyUserTool } from "@/tools/telegram/NotifyUserTool";
import { createShareFileToPhoneTool } from "@/tools/telegram/ShareFileToPhoneTool";
import { createOpenChatTool } from "@/tools/telegram/OpenChatTool";
import { PollinationsImageClient } from "@/images/PollinationsImageClient";
import { CloudflareImageClient } from "@/images/CloudflareImageClient";
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
  // Semantic Memory Search / Semantic Result Cache (additive, opt-in —
  // JARVIS_ROADMAP_AUDIT.md #60): only constructed when
  // OLLAMA_EMBEDDING_MODEL is set, so every existing exact-match code path
  // (MemoryStore.search LIKE matching, ToolResultCache's exact-match
  // cache) has zero dependency on Ollama when this is unset, the default.
  // See README's "Semantic memory & caching (optional, local-only)"
  // section.
  const embeddingsClient = config.ollamaEmbeddingModel
    ? new OllamaEmbeddingsClient({ baseUrl: config.ollamaBaseUrl, model: config.ollamaEmbeddingModel })
    : undefined;
  const toolRegistry = new ToolRegistry();
  const memoryStore = new MemoryStore(config.memoryDbPath);
  const reminderStore = new ReminderStore(config.remindersDbPath, config.timezone);
  // Security layer for proactive, JARVIS-initiated "wake up and speak"
  // reminders (CLAUDE.md wishlist #19) — see SpeakerAuthenticator.ts for
  // why this is a separate, narrow interface from ConfirmationService.
  // seedIfEmpty only ever applies on a fresh store with nothing set yet;
  // SET_CONFIRMATION_PASSPHRASE always wins once used.
  const confirmationPassphraseStore = new ConfirmationPassphraseStore(config.confirmationPassphraseDbPath);
  confirmationPassphraseStore.seedIfEmpty(config.confirmationPassphraseSeed);
  const speakerAuthenticator = new PassphraseSpeakerAuthenticator(() => confirmationPassphraseStore.get());
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
  // Correction Learning: see src/behavior/BehaviorCorrectionStore.ts's own
  // doc comment for why this is a separate store from MemoryStore. Created
  // here (alongside the other stores MemoryExtractor/buildContextNote need)
  // rather than down near agentTaskStore/goalStore — unlike those, nothing
  // about it depends on `orchestrator` existing first.
  const behaviorCorrectionStore = new BehaviorCorrectionStore(config.behaviorCorrectionsDbPath);
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
    // One-time, best-effort: identifies the real email of any account
    // carried over from the old single-account schema (see
    // CalendarTokenStore's own migration) so it becomes addressable by
    // email like every newly-linked account. Fire-and-forget — a
    // transient network failure here must never block JARVIS from
    // starting, and the account keeps working for Calendar/Gmail in the
    // meantime regardless.
    calendarClient.backfillLegacyAccountEmails().catch((err) => {
      console.error(
        "[jarvis] Legacy Google account email backfill failed at startup (will retry on next restart):",
        err instanceof Error ? err.message : String(err)
      );
    });
    toolRegistry.registerTool(createListCalendarEventsTool(calendarClient));
    toolRegistry.registerTool(createSearchCalendarEventsTool(calendarClient));
    toolRegistry.registerTool(createGetCalendarEventTool(calendarClient));
    toolRegistry.registerTool(createUpdateCalendarEventTool(calendarClient, undoStore));
    toolRegistry.registerTool(createCreateCalendarEventTool(calendarClient, undoStore));
    toolRegistry.registerTool(createDeleteCalendarEventTool(calendarClient, undoStore));
    toolRegistry.registerTool(createUnlinkCalendarTool(calendarTokenStore));
    toolRegistry.registerTool(createListLinkedGoogleAccountsTool(calendarTokenStore));
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

  // Shares the same Google account link as Calendar/Gmail (one OAuth
  // consent screen, more scopes) — see GoogleCalendarClient's GOOGLE_SCOPES
  // for the drive.readonly/drive.file/documents/presentations scopes this
  // depends on, and its doc comment for why an already-linked account needs
  // one re-consent (GET /calendar/oauth/start again) before
  // CREATE_PRESENTATION/CREATE_CHECKLIST/FIND_DRIVE_FILE/SEARCH_DRIVE_FILES
  // actually work.
  const driveClient = calendarEnabled ? new GoogleDriveClient(config.googleClientId!, config.googleClientSecret!, calendarTokenStore) : undefined;
  if (driveClient) {
    const slidesClient = new GoogleSlidesClient(driveClient);
    const docsClient = new GoogleDocsClient(driveClient);
    toolRegistry.registerTool(createCreatePresentationTool(slidesClient));
    toolRegistry.registerTool(createCreateChecklistTool(docsClient));
    toolRegistry.registerTool(createCreateDocumentTool(docsClient));
    toolRegistry.registerTool(createFindDriveFileTool(driveClient));
    toolRegistry.registerTool(createSearchDriveFilesTool(driveClient));
  }

  // YouTube (read-only): same shared Google account link as Calendar/Gmail/
  // Drive — see GoogleCalendarClient's GOOGLE_SCOPES for the
  // youtube.readonly scope this depends on. No separate env var for the
  // credential itself since it reuses googleClientId/googleClientSecret;
  // gated on the same calendarEnabled flag so it activates automatically
  // once Google is linked.
  const youtubeClient = calendarEnabled ? new YouTubeClient(config.googleClientId!, config.googleClientSecret!, calendarTokenStore) : undefined;
  if (youtubeClient) {
    toolRegistry.registerTool(createGetMyYouTubeChannelTool(youtubeClient));
    toolRegistry.registerTool(createListMyYouTubeVideosTool(youtubeClient));
    toolRegistry.registerTool(createGetYouTubeVideoStatsTool(youtubeClient));
  }

  // AgentMail — JARVIS's own independent email inbox, wholly separate
  // from the Google account link above (no shared token store, no shared
  // OAuth scope, never touches GmailClient/GoogleCalendarClient at all).
  // Unconfigured means this simply doesn't register — no crash, no
  // warning spam, just the one log line below when it IS configured.
  const agentMailEnabled = Boolean(config.agentMailApiKey && config.agentMailInboxId);
  if (agentMailEnabled) {
    const agentMailClient = new AgentMailClient(config.agentMailApiKey!, config.agentMailInboxId!);
    const agentMailSendGuard = new AgentMailSendGuard(config.agentMailMaxSendsPerDay);
    toolRegistry.registerTool(
      createSendAgentEmailTool(agentMailClient, agentMailSendGuard, () => formatDateKey(new Date(), config.timezone))
    );
    toolRegistry.registerTool(createCheckAgentInboxTool(agentMailClient));
    console.log(`[jarvis] AgentMail integration enabled (inbox: ${config.agentMailInboxId})`);
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

  const canvaEnabled = Boolean(config.canvaClientId && config.canvaClientSecret && config.publicBaseUrl);
  const canvaTokenStore = new CanvaTokenStore(config.canvaTokenDbPath);
  const canvaClient = canvaEnabled
    ? new CanvaClient(
        config.canvaClientId!,
        config.canvaClientSecret!,
        new URL("/canva/oauth/callback", config.publicBaseUrl).toString(),
        canvaTokenStore
      )
    : undefined;
  if (canvaClient) {
    toolRegistry.registerTool(createListCanvaDesignsTool(canvaClient));
    toolRegistry.registerTool(createListCanvaBrandTemplatesTool(canvaClient));
    toolRegistry.registerTool(createCreateCanvaDesignTool(canvaClient));
  }

  // GitHub integration: a single static fine-grained PAT (no OAuth flow,
  // no per-account linking — see GitHubClient's own doc comment and the
  // introducing PR for why) — gated on GITHUB_TOKEN alone, unlike
  // Spotify/Calendar which also require publicBaseUrl for an OAuth
  // redirect this integration doesn't need.
  const githubClient = config.githubToken ? new GitHubClient(config.githubToken) : undefined;
  if (githubClient) {
    toolRegistry.registerTool(createListGitHubCommitsTool(githubClient));
    toolRegistry.registerTool(createListGitHubIssuesTool(githubClient));
    toolRegistry.registerTool(createListGitHubPullRequestsTool(githubClient));
    toolRegistry.registerTool(createCheckGitHubRepoActivityTool(githubClient));
    // Write operations (comment/merge) — follow-up to the read-only v1.
    // IMPORTANT: these need write-level Issues/Pull-requests permissions on
    // the same fine-grained PAT (GITHUB_TOKEN), which the original setup
    // only granted read-only. Registering them here regardless (rather than
    // gating on a separate env var) so they're available as soon as David
    // updates the token's permissions — until then they'll simply fail with
    // a real 403 from GitHub on first use, per CommentOnGitHubIssueTool/
    // MergeGitHubPullRequestTool's own doc comments. See the PR description
    // for the exact permission-update steps.
    toolRegistry.registerTool(createCommentOnGitHubIssueTool(githubClient));
    toolRegistry.registerTool(createMergeGitHubPullRequestTool(githubClient));
    console.log("[jarvis] GitHub integration enabled (including write operations — requires Issues/Pull-requests write permission on GITHUB_TOKEN)");
  }

  // Proactive GitHub activity surfacing (CLAUDE.md "continuous personal
  // profile" background: "continuously watch my repos... surface relevant
  // things without being asked"). Gated on githubClient AND (at least one
  // explicitly watched repo OR auto-discovery of owned repos being on) —
  // someone could set GITHUB_TOKEN without configuring either, in which case
  // this whole feature stays inert (no polling, no note), which is the
  // correct safe default rather than silently polling every repo the token
  // can read.
  //
  // The store is always constructed (cheap — just opens/creates a small
  // SQLite file) so githubActivityNote always has something to read, but
  // it only ever contains anything once the poller below actually runs.
  const githubActivityStore = new GitHubActivityStore(config.githubActivityDbPath);
  const githubActivityEnabled = Boolean(
    githubClient && (config.githubWatchedRepos.length > 0 || config.githubWatchAllOwnRepos)
  );
  let githubActivityInterval: ReturnType<typeof setInterval> | undefined;
  if (githubActivityEnabled) {
    // Same in-flight-guard shape as weeklyDigestInterval above: a poll
    // involves real network calls (one or more repos, each multiple GitHub
    // API requests), so a slow poll straddling a tick boundary must not
    // let a second tick start an overlapping poll — only boolean-level
    // dedup is needed (there's only ever one poll "job" per tick, unlike
    // the per-item id-set pattern used where a tick enumerates many
    // independent due items).
    let pollInFlight = false;
    githubActivityInterval = setInterval(() => {
      schedulerHealthTracker.tick("githubActivity");
      if (pollInFlight) return;
      pollInFlight = true;
      // Re-resolved every tick (not once at boot) so a repo David creates
      // after JARVIS starts, or deletes, is reflected on the very next
      // cycle rather than requiring a restart — see resolveWatchedRepos's
      // own doc comment.
      resolveWatchedRepos(githubClient!, config.githubWatchedRepos, config.githubWatchAllOwnRepos)
        .then((watchedRepos) => pollGitHubActivity(githubClient!, githubActivityStore, watchedRepos))
        .then(() => {
          // Immediate push for whatever this tick just found new — the
          // same capability news watching already has (see
          // newsWatcherScheduler below and WatcherNotifier's own doc
          // comment). Previously GitHub activity only ever surfaced at
          // the start of the NEXT conversation via githubActivityNote;
          // that note keeps working exactly as before (it reads the same
          // store, independently) — this is additive, not a replacement,
          // with the same honest "could mention the same item twice"
          // tradeoff news already accepts.
          //
          // watcherNotifier/watcherChannelConfig are declared further
          // down in this same function (closed over here, not yet in
          // scope lexically) — safe because this callback only ever runs
          // once main() has finished its synchronous setup and both are
          // initialized, exactly like newsWatcherScheduler's own tick.
          if (!config.watcherPushNotificationsEnabled) return;
          for (const record of githubActivityStore.listRecentActivity()) {
            const sourceId = `github:${record.owner}/${record.repo}`;
            const text = `JARVIS spotted new GitHub activity — ${formatRepoActivitySummary(record)}`;
            watcherNotifier.notify(sourceId, text, watcherChannelConfig).catch((error) => {
              console.error(`[jarvis] watcher notify failed for "${sourceId}":`, error instanceof Error ? error.message : String(error));
            });
          }
        })
        .catch((error) => {
          // pollGitHubActivity already isolates per-repo failures and
          // resolveWatchedRepos already isolates auto-discovery failures —
          // this only catches a truly unexpected error (e.g. a bug), so the
          // scheduler tick itself can never crash the process.
          console.error("[jarvis] GitHub activity poll tick failed:", error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          pollInFlight = false;
        });
    }, config.githubActivityPollMs);
    console.log(
      `[jarvis] GitHub activity watching ${config.githubWatchedRepos.length} explicitly-listed repo(s)` +
        (config.githubWatchAllOwnRepos ? " plus auto-discovery of every repo David owns" : "") +
        `, polling every ${config.githubActivityPollMs}ms`
    );
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

  const newsClient = config.newsRssUrl ? new RssNewsClient(config.newsRssUrl) : undefined;
  if (newsClient) {
    toolRegistry.registerTool(createGetNewsTool(newsClient));
    toolRegistry.registerTool(createSearchNewsTool(newsClient));
  }

  // Proactive news-by-topic watching — the generalized Proactive Watcher's
  // first non-GitHub source (CLAUDE.md "Approved for build: generalized
  // Proactive Watcher"). Same opt-in-and-otherwise-inert posture as GitHub
  // activity watching above: needs both a configured feed (newsClient) AND
  // at least one watched topic, and the store is always constructed
  // (cheap) so the context note always has something to read even before
  // the poller below has run. Polling itself (newsWatcherScheduler) is set
  // up further below, once telegramGateway/proactiveAnnouncer exist — an
  // immediate push notification (when WATCHER_PUSH_NOTIFICATIONS_ENABLED)
  // needs both.
  const newsWatcherStore = new WatcherStore(config.newsWatchDbPath);
  const newsWatchSources = newsClient ? createNewsWatchSources(newsClient, config.newsWatchTopics) : [];
  const newsWatchEnabled = newsWatchSources.length > 0;
  const newsWatchContext = newsWatchEnabled ? { store: newsWatcherStore, sources: newsWatchSources } : undefined;

  // Self-improvement suggestion watcher (CLAUDE.md "build the
  // self-improvement suggestion engine") — on by default, see
  // `config.selfImprovementWatchEnabled`'s own doc comment for why. Store is
  // always constructed (cheap, same posture as `newsWatcherStore` above) so
  // the context note always has something to read even before the poller
  // below has run its first tick.
  const selfImprovementStore = new WatcherStore(config.selfImprovementDbPath);
  const selfImprovementSource = createSelfImprovementWatchSource();

  // Proactive Gmail watching — the generalized Proactive Watcher's Gmail
  // source (CLAUDE.md: deferred when the Watcher was first generalized
  // because "email has different OAuth/credential-polling semantics than
  // RSS" — closed out here by reusing the existing `gmailClient` entirely,
  // no new Gmail API code). Same opt-in-and-otherwise-inert posture as
  // GitHub/news watching above: needs both a linked Google account
  // (`gmailClient`) AND at least one configured `GMAIL_WATCH_QUERIES`
  // entry, and the store is always constructed (cheap) so the context note
  // always has something to read even before the poller below has run.
  const gmailWatcherStore = new WatcherStore(config.gmailWatchDbPath);
  const gmailWatchSources = gmailClient ? createGmailWatchSources(gmailClient, config.gmailWatchQueries) : [];
  const gmailWatchEnabled = gmailWatchSources.length > 0;
  const gmailWatchContext = gmailWatchEnabled ? { store: gmailWatcherStore, sources: gmailWatchSources } : undefined;

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
  toolRegistry.registerTool(captureScreenshotTool);
  toolRegistry.registerTool(lookAtScreenTool);
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
  toolRegistry.registerTool(createSaveMemoryTool(memoryStore, embeddingsClient));
  toolRegistry.registerTool(createSearchMemoryTool(memoryStore, embeddingsClient));
  toolRegistry.registerTool(createDeleteMemoryTool(memoryStore, undoStore));
  toolRegistry.registerTool(createCreateReminderTool(reminderStore));
  toolRegistry.registerTool(createListRemindersTool(reminderStore));
  toolRegistry.registerTool(createCompleteReminderTool(reminderStore));
  toolRegistry.registerTool(createDeleteReminderTool(reminderStore, undoStore));
  toolRegistry.registerTool(createUpdateReminderTool(reminderStore));
  toolRegistry.registerTool(createSetConfirmationPassphraseTool(confirmationPassphraseStore));
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
  // CONFIRM (see SetConfirmationPassphraseTool's own doc comment): granted
  // so it's askable at all, but PermissionService still forces a fresh
  // per-invocation confirmation regardless — changing the owner's own
  // proactive-reply security passphrase never happens silently.
  permissionService.grant(DEFAULT_USER_ID, "SET_CONFIRMATION_PASSPHRASE");
  permissionService.grant(DEFAULT_USER_ID, "CREATE_AUTOMATION_RULE");
  permissionService.grant(DEFAULT_USER_ID, "UPDATE_AUTOMATION_RULE");
  permissionService.grant(DEFAULT_USER_ID, "DELETE_AUTOMATION_RULE");
  permissionService.grant(DEFAULT_USER_ID, "CREATE_COMMITMENT");
  permissionService.grant(DEFAULT_USER_ID, "FULFILL_COMMITMENT");
  // Goal Engine (roadmap items 26-27) — same single-user SAFE_ACTION
  // reasoning as CREATE_REMINDER/CREATE_COMMITMENT: creating/closing a goal
  // record has no real-world side effect of its own (its individual steps'
  // own permission levels gate anything that actually does something).
  permissionService.grant(DEFAULT_USER_ID, "CREATE_GOAL");
  permissionService.grant(DEFAULT_USER_ID, "COMPLETE_GOAL");
  permissionService.grant(DEFAULT_USER_ID, "CANCEL_GOAL");
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
  if (canvaClient) {
    // CONFIRM (see CreateCanvaDesignTool's own doc comment): the grant only
    // makes it askable at all — PermissionService still forces a fresh
    // per-invocation confirmation regardless, same as SEND_EMAIL/REPLY_EMAIL.
    permissionService.grant(DEFAULT_USER_ID, "CREATE_CANVA_DESIGN");
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
  // The other standing grant a device can accumulate: pairing approval's
  // own autoGrantToolIdsOnApproval list (passed to JarvisWebSocketServer
  // below). Kept in one place and referenced by both so `device.revoked`
  // below actually clears everything a device could have been granted,
  // instead of drifting out of sync with whatever tools approval grants.
  const AUTO_GRANTED_ON_APPROVAL_TOOLS = [
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
    "WRITE_FILE",
    "CAPTURE_SCREENSHOT",
    "LOOK_AT_SCREEN",
  ];
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
  const ALL_STANDING_DEVICE_GRANT_TOOLS = [...new Set([...STANDARD_PRIMARY_DEVICE_TOOLS, ...AUTO_GRANTED_ON_APPROVAL_TOOLS])];
  eventBus.on("device.revoked", ({ deviceId }) => {
    for (const toolId of ALL_STANDING_DEVICE_GRANT_TOOLS) {
      permissionService.revoke(DEFAULT_USER_ID, toolId, deviceId);
    }
  });

  const pairingService = new PairingService(undefined, undefined, config.pairingDbPath);
  const deviceConnectionManager = new DeviceConnectionManager(eventBus);
  const proactiveAnnouncer = new ProactiveAnnouncer(deviceConnectionManager, speakerAuthenticator);
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
  // Ollama is a fourth, independent free-tier provider: a user-run local
  // model server, not a hosted account. It only activates when
  // OLLAMA_MODEL is explicitly set — OLLAMA_BASE_URL defaulting to
  // Ollama's real default port is not itself a reason to assume the user
  // has a model pulled and running. Always registered as "free": there is
  // no paid-tier concept for a locally-run model at all, unlike
  // OpenRouter's mixed marketplace, so no per-model gate is needed here.
  if (config.ollamaModel) {
    aiRegistry.register(
      "ollama",
      new OllamaBrain(config.ollamaApiKey, { model: config.ollamaModel, baseUrl: config.ollamaBaseUrl }),
      "free"
    );
  }
  // Cloudflare Workers AI is a fifth, independent free-tier provider: a
  // real hosted account (unlike Ollama), so it only activates once ALL
  // THREE of account id/API token/model are explicitly set — a partial
  // config stays inert rather than half-working. Always registered as
  // "free": Cloudflare's own docs confirm exceeding the 10,000-Neuron
  // daily allocation makes further calls fail rather than silently bill,
  // so this is genuinely $0 the same way Groq/OpenRouter/Ollama are — see
  // CloudflareWorkersAIBrain's own doc comment.
  if (config.cloudflareAccountId && config.cloudflareApiToken && config.cloudflareModel) {
    aiRegistry.register(
      "cloudflare-workers-ai",
      new CloudflareWorkersAIBrain(config.cloudflareAccountId, config.cloudflareApiToken, {
        model: config.cloudflareModel,
      }),
      "free"
    );
  }
  // Gemini is a sixth, independent free-tier provider: a real Google AI
  // Studio account, gated by the API key's own free-tier rate limits (not
  // a per-model price tag the way OpenRouter's catalog is), so only the
  // key is required — GEMINI_API_KEY unset means it's simply unavailable,
  // exactly like every other optional provider here. Always registered as
  // "free": see GeminiBrain's own doc comment for why there's no
  // analogous ":free"-suffix-style check needed the way OpenRouterBrain
  // has one.
  if (config.geminiApiKey) {
    aiRegistry.register("gemini", new GeminiBrain(config.geminiApiKey, { model: config.geminiModel }), "free");
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
    freeProviderPriority: config.aiFreeProviderPriority,
    maxDailyCostUsd: config.maxDailyCostUsd,
    maxMonthlyCostUsd: config.maxMonthlyCostUsd,
    maxCostPerRunUsd: config.maxCostPerRunUsd,
    zeroCostMode: config.zeroCostMode,
    softBudgetCapRatio: config.softBudgetCapRatio,
    circuitBreakerThreshold: config.aiCircuitBreakerThreshold,
    circuitBreakerCooldownMs: config.aiCircuitBreakerCooldownMs,
    eventBus,
  });
  // Kept as a typed AIRouter (not just the narrower Brain interface) so
  // GET /providers/health can call its getProviderStatus() — see
  // JARVIS_ROADMAP_AUDIT.md #174.
  const brain: Brain = aiRouter;
  // Continuous Memory/Profile (JARVIS_MASTER_PLAN.md Phase 1): one shared
  // instance across every channel's Orchestrator below, same reasoning as
  // `brain`/`toolResultCache` being shared — a background extraction call
  // from the phone channel writes to the exact same MemoryStore a web-chat
  // SAVE_MEMORY call does. `undefined` when disabled means every
  // Orchestrator below gets no `memoryExtractor` at all, identical to
  // before this feature existed.
  const memoryExtractor = config.memoryExtractionEnabled
    ? new MemoryExtractor(brain, memoryStore, eventBus, behaviorCorrectionStore)
    : undefined;
  const confirmationService = new ConfirmationService(confirmViaChat);
  const phoneConfirmationService = new ConfirmationService(denyPhoneConfirmation);
  // Shared across every channel's Orchestrator below — a repeated
  // READ-level tool call (e.g. GET_WEATHER for the same location) hits
  // this cache regardless of which channel asked first. TTL 0
  // (JARVIS_TOOL_RESULT_CACHE_TTL_MS=0) disables caching entirely; see
  // ToolResultCache's own doc comment.
  const toolResultCache = new ToolResultCache(config.toolResultCacheTtlMs);

  // Set once `agentCore` exists below — `orchestrator` needs this hook at
  // construction time, but `agentCore` itself needs `orchestrator` as one
  // of its own dependencies, so a plain forward-reference box breaks the
  // ordering cycle without restructuring either constructor. Until it's
  // set, `requestStop` simply has no agent task to cancel (same as the
  // hook being entirely absent).
  let agentCoreForCancel: AgentCore | undefined;

  // Hoisted above `orchestrator` (which only needs these as closures captured
  // in `contextProvider`, not called until a real turn runs) so both the Goal
  // Engine's own tools and every `buildContextNote` call site below can see
  // the same instances — see the Autonomous Agent Core comment further down
  // for what `agentTaskStore` itself is for.
  const agentTaskStore = new AgentTaskStore(config.agentTaskDbPath);
  // Goal Engine (roadmap items 26-27): tracks what the user asked JARVIS to
  // help with across conversations. `GoalStore` only ever remembers a goal's
  // own identity/status (the user's words, active/completed/abandoned) —
  // all step/progress data lives in `agentTaskStore`, grouped by the same
  // `goalId` (see `GoalStore`'s own doc comment for why the split).
  const goalStore = new GoalStore(config.goalsDbPath);

  const orchestrator = new Orchestrator({
    brain,
    conversation,
    toolRegistry,
    permissionService,
    eventBus,
    deviceRegistry,
    deviceConnectionManager,
    confirmationService,
    contextProvider: (message) =>
      buildContextNote(
        config,
        reminderStore,
        calendarClient,
        commitmentStore,
        { goalStore, taskStore: agentTaskStore, userId: DEFAULT_USER_ID },
        behaviorCorrectionStore,
        message,
        githubActivityStore,
        newsWatchContext,
        gmailWatchContext,
        selfImprovementStore
      ),
    lockdownService,
    toolResultCache,
    embeddingsClient,
    memoryExtractor,
    maxToolCallsPerRun: config.maxToolCallsPerRun,
    localToolTimeoutMs: config.localToolTimeoutMs,
    liveState: liveStateTracker,
    // Default liveStateChannel ("chat") — this is the primary web-chat/
    // terminal Orchestrator (see webChatOrchestrator below), so its
    // sessions use the plain "chat:${userId}" key.
    agentTaskCanceller: {
      cancelActiveTasksForUser: (userId) => agentCoreForCancel?.cancelActiveTasksForUser(userId) ?? [],
    },
  });

  // Autonomous Agent Core — persistent/priority task queue + background
  // worker (roadmap items 31-34), and the execution substrate the Goal
  // Engine's CREATE_GOAL/CHECK_GOAL_PROGRESS/COMPLETE_GOAL/CANCEL_GOAL tools
  // (registered below) sit on top of. Reuses the exact same Orchestrator/
  // ToolRegistry/PermissionService pipeline as any other tool call; never
  // wired into `Orchestrator.handleUserMessage` itself, an explicit opt-in
  // surface only. `resumeIncompleteTasks()` runs once, synchronously, before
  // the queue worker's first tick, so a task a previous process left
  // mid-flight (PLANNING/EXECUTING/VERIFYING/RETRYING/RECOVERING/WAITING) is
  // failed cleanly with a clear reason instead of sitting there forever,
  // invisible — see the doc comment on `AgentCore.resumeIncompleteTasks` for
  // why that's the safe default rather than attempting a risky
  // mid-tool-execution resume. (`agentTaskStore`/`goalStore` themselves are
  // created above, before `orchestrator`, so its `contextProvider` can see them.)
  const agentCore = new AgentCore({
    orchestrator,
    planner: new BrainAgentPlanner(brain, toolRegistry),
    toolRegistry,
    taskStore: agentTaskStore,
    auditLog: toolAuditLog,
    eventBus,
    liveState: liveStateTracker,
  });
  agentCoreForCancel = agentCore;
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

  // Goal Engine tool-level interface — registered here (not alongside the
  // other SAFE_ACTION tools above) because these need `agentCore`/
  // `agentTaskStore`, which don't exist until this point.
  toolRegistry.registerTool(createCreateGoalTool(goalStore, agentCore));
  toolRegistry.registerTool(createCheckGoalProgressTool(goalStore, agentTaskStore));
  toolRegistry.registerTool(createCompleteGoalTool(goalStore));
  toolRegistry.registerTool(createCancelGoalTool(goalStore, agentCore, agentTaskStore));

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
      contextProvider: (message) =>
        buildContextNote(
          config,
          reminderStore,
          calendarClient,
          commitmentStore,
          { goalStore, taskStore: agentTaskStore, userId: DEFAULT_USER_ID },
          behaviorCorrectionStore,
          message,
          githubActivityStore,
          newsWatchContext,
          gmailWatchContext,
          selfImprovementStore
        ),
      lockdownService,
      toolResultCache,
      embeddingsClient,
      memoryExtractor,
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
      contextProvider: (message) =>
        buildContextNote(
          config,
          reminderStore,
          calendarClient,
          commitmentStore,
          { goalStore, taskStore: agentTaskStore, userId: DEFAULT_USER_ID },
          behaviorCorrectionStore,
          message,
          githubActivityStore,
          newsWatchContext,
          gmailWatchContext,
          selfImprovementStore
        ),
      lockdownService,
      toolResultCache,
      embeddingsClient,
      memoryExtractor,
      maxToolCallsPerRun: config.maxToolCallsPerRun,
      localToolTimeoutMs: config.localToolTimeoutMs,
      liveState: liveStateTracker,
      liveStateChannel: "wakeup-call",
    });
    return { orchestrator: phoneOrchestrator, userId: DEFAULT_USER_ID };
  }

  // Media Streams is a real, small extra Twilio cost (~$0.004/min on top
  // of call minutes) — only wired up when explicitly enabled, and only
  // meaningful once the phone gateway itself is configured. Requires
  // twilioAuthToken too (not just twilioPublicBaseUrl) — the ingest route
  // in JarvisWebSocketServer needs it to verify Twilio's signature and
  // now fails closed without it, so constructing the broadcaster (and
  // advertising audioStreamUrl below) without it would just produce a
  // waveform feature whose ingest endpoint permanently 404s.
  const audioLevelBroadcaster =
    config.audioWaveformEnabled && config.twilioAuthToken && config.twilioPublicBaseUrl
      ? new AudioLevelBroadcaster()
      : undefined;
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
      contextProvider: (message) =>
        buildContextNote(
          config,
          reminderStore,
          calendarClient,
          commitmentStore,
          { goalStore, taskStore: agentTaskStore, userId: DEFAULT_USER_ID },
          behaviorCorrectionStore,
          message,
          githubActivityStore,
          newsWatchContext,
          gmailWatchContext,
          selfImprovementStore
        ),
      lockdownService,
      toolResultCache,
      embeddingsClient,
      memoryExtractor,
      maxToolCallsPerRun: config.maxToolCallsPerRun,
      localToolTimeoutMs: config.localToolTimeoutMs,
      liveState: liveStateTracker,
      liveStateChannel: "sms",
    });
    return { orchestrator: smsOrchestrator, userId: DEFAULT_USER_ID };
  }

  // Rides the same Twilio number/credentials the phone gateway already
  // requires — no new account, number, or secret needed to turn this on.
  // Also rides the phone gateway's own fail-closed allowlist gate
  // (phoneGatewayAllowlistOk, above): handleSmsWebhook enforces
  // twilioAllowedCallers exactly like the phone gateway does, but only
  // when one is actually configured — without gating construction on
  // phoneGatewayAllowlistOk too, an operator who sets the Twilio
  // credentials but forgets TWILIO_ALLOWED_CALLERS (and never opts into
  // TWILIO_ALLOW_OPEN_ACCESS) would have the phone gateway correctly
  // refuse to start while the SMS gateway silently accepted texts from
  // any phone number.
  if (config.twilioAuthToken && config.twilioPublicBaseUrl && !phoneGatewayAllowlistOk) {
    console.error(
      "[jarvis] SMS gateway NOT started: TWILIO_AUTH_TOKEN/TWILIO_PUBLIC_BASE_URL are set but " +
        "TWILIO_ALLOWED_CALLERS is empty. Set TWILIO_ALLOWED_CALLERS to the E.164 numbers that may text in, " +
        "or set TWILIO_ALLOW_OPEN_ACCESS=true to intentionally accept texts from anyone."
    );
  }
  const smsGateway =
    config.twilioAuthToken && config.twilioPublicBaseUrl && phoneGatewayAllowlistOk
      ? new TwilioSmsGateway(createSmsSession)
      : undefined;

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
      contextProvider: (message) =>
        buildContextNote(
          config,
          reminderStore,
          calendarClient,
          commitmentStore,
          { goalStore, taskStore: agentTaskStore, userId: DEFAULT_USER_ID },
          behaviorCorrectionStore,
          message,
          githubActivityStore,
          newsWatchContext,
          gmailWatchContext,
          selfImprovementStore
        ),
      lockdownService,
      toolResultCache,
      embeddingsClient,
      memoryExtractor,
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

  // Generalized Proactive Watcher: urgency-to-channel router + the shared
  // polling scheduler for watch sources built against the generic
  // `WatchSource` interface (today: news-by-topic; GitHub keeps its own
  // specialized interval above — see GitHubActivityStore.ts's doc comment
  // for why). `watcherNotifier` is what actually sends an immediate
  // notification (vs. only caching for the next conversation's context
  // note) — see WatcherNotifier's own doc comment for the channel-honesty
  // rules (phone is a deliberate no-op stub; device-announce only fires
  // when a source is explicitly configured high-priority AND a device id
  // is configured, otherwise it falls back to Telegram).
  const watcherChannelConfig = {
    ...emptyWatcherChannelConfig(),
    highPrioritySourceIds: new Set(config.watcherHighPrioritySourceIds),
    // The self-improvement source is pinned to the quietest channel always,
    // by hardcoded id — never derived from WATCHER_HIGH_PRIORITY_SOURCES or
    // any other env var, so no configuration mistake can ever make JARVIS's
    // own self-improvement suggestions ring a device or place a call. See
    // CLAUDE.md: "self-improvement suggestions should NEVER be treated as
    // high-urgency/device-announce-worthy."
    alwaysQuietSourceIds: new Set([SELF_IMPROVEMENT_SOURCE_ID]),
  };
  const watcherNotifier = new WatcherNotifier(telegramGateway, config.telegramOwnerChatId, proactiveAnnouncer, config.watcherAnnounceDeviceId);

  let newsWatcherScheduler: ReturnType<typeof createPollScheduler> | undefined;
  if (newsWatchEnabled) {
    newsWatcherScheduler = createPollScheduler(
      [
        () =>
          pollWatchSources(newsWatchSources, newsWatcherStore, (sourceId, error) => {
            console.error(`[jarvis] news watch poll failed for "${sourceId}":`, error instanceof Error ? error.message : String(error));
          }).then(() => {
            if (!config.watcherPushNotificationsEnabled) return;
            // Immediate push for whatever this tick just found new — see
            // WatcherNotifier's own doc comment for why this is a real,
            // additional capability beyond the context-note surfacing
            // above, and the introducing PR description for the honest
            // "both can fire for the same event" tradeoff this implies.
            for (const record of newsWatcherStore.listWithActivity<{ title: string }>()) {
              const source = newsWatchSources.find((s) => s.id === record.sourceId);
              if (!source) continue;
              const text = `JARVIS spotted ${record.newItems.length} new headline(s) for "${source.label}": ${record.newItems
                .slice(0, 3)
                .map((item) => `"${item.title}"`)
                .join(", ")}`;
              watcherNotifier.notify(source.id, text, watcherChannelConfig).catch((error) => {
                console.error(`[jarvis] watcher notify failed for "${source.id}":`, error instanceof Error ? error.message : String(error));
              });
            }
          }),
      ],
      config.newsWatchPollMs,
      { onTick: () => schedulerHealthTracker.tick("newsWatch") }
    );
    console.log(`[jarvis] News watching ${newsWatchSources.length} topic(s), polling every ${config.newsWatchPollMs}ms`);
  }

  // Proactive Gmail watching's own poller/push — same shared scheduler and
  // push mechanism as news above, just against `gmailWatchSources`/
  // `gmailWatcherStore`. `source.describe(item)` already caps what's shown
  // (sender/subject/short snippet preview, never the full body — see
  // `gmailWatchSource.ts`'s own doc comment), so the push text here reuses
  // it directly rather than re-truncating ad hoc the way news's inline
  // template does for headline titles.
  let gmailWatcherScheduler: ReturnType<typeof createPollScheduler> | undefined;
  if (gmailWatchEnabled) {
    gmailWatcherScheduler = createPollScheduler(
      [
        () =>
          pollWatchSources(gmailWatchSources, gmailWatcherStore, (sourceId, error) => {
            console.error(`[jarvis] Gmail watch poll failed for "${sourceId}":`, error instanceof Error ? error.message : String(error));
          }).then(() => {
            if (!config.watcherPushNotificationsEnabled) return;
            for (const record of gmailWatcherStore.listWithActivity<EmailSummary>()) {
              const source = gmailWatchSources.find((s) => s.id === record.sourceId);
              if (!source) continue;
              const text = `JARVIS spotted ${record.newItems.length} new email(s) matching "${source.label}": ${record.newItems
                .slice(0, 3)
                .map((item) => source.describe(item))
                .join("; ")}`;
              watcherNotifier.notify(source.id, text, watcherChannelConfig).catch((error) => {
                console.error(`[jarvis] watcher notify failed for "${source.id}":`, error instanceof Error ? error.message : String(error));
              });
            }
          }),
      ],
      config.gmailWatchPollMs,
      { onTick: () => schedulerHealthTracker.tick("gmailWatch") }
    );
    console.log(`[jarvis] Gmail watching ${gmailWatchSources.length} quer(y/ies), polling every ${config.gmailWatchPollMs}ms`);
  }

  // Self-improvement suggestion watcher's own scheduler — a separate
  // interval from news (weekly-scale vs. 20-minute-scale cadence; sharing
  // one scheduler/interval across both would force them onto the same
  // tick rate). Always-quiet channel is enforced via `watcherChannelConfig`
  // above regardless of `config.watcherPushNotificationsEnabled`.
  let selfImprovementScheduler: ReturnType<typeof createPollScheduler> | undefined;
  if (config.selfImprovementWatchEnabled) {
    selfImprovementScheduler = createPollScheduler(
      [
        () =>
          pollWatchSources([selfImprovementSource], selfImprovementStore, (sourceId, error) => {
            console.error(`[jarvis] self-improvement watch poll failed for "${sourceId}":`, error instanceof Error ? error.message : String(error));
          }).then(() => {
            if (!config.watcherPushNotificationsEnabled) return;
            const note = selfImprovementNote(selfImprovementStore);
            if (!note) return;
            watcherNotifier.notify(SELF_IMPROVEMENT_SOURCE_ID, note, watcherChannelConfig).catch((error) => {
              console.error(`[jarvis] watcher notify failed for "${SELF_IMPROVEMENT_SOURCE_ID}":`, error instanceof Error ? error.message : String(error));
            });
          }),
      ],
      config.selfImprovementPollMs,
      { onTick: () => schedulerHealthTracker.tick("selfImprovementWatch") }
    );
    console.log(`[jarvis] Self-improvement suggestion watcher enabled, polling every ${config.selfImprovementPollMs}ms`);
  }

  // OPEN_CHAT only needs the bot's public username (to build the t.me
  // link), but it's only actually useful once the Telegram gateway itself
  // is live — otherwise the link it hands out leads to a bot that can't
  // reply. Gated the same way as NOTIFY_USER/SHARE_FILE_TO_PHONE above.
  if (telegramGateway && config.telegramBotUsername) {
    toolRegistry.registerTool(createOpenChatTool(config.telegramBotUsername));
    permissionService.grant(DEFAULT_USER_ID, "OPEN_CHAT");
  }

  // Staged cost alerts (75%/90%/100% of JARVIS_COST_ALERT_THRESHOLD_USD)
  // used to only log to console/ActivityLog — invisible unless someone
  // was actively watching `flyctl logs` or the dashboard. Pushed to the
  // owner's phone via Telegram now, the same channel every other
  // proactive notification (alarms, check-ins, morning briefing) already
  // uses, so a real spend spike is actually noticed in time to act on it
  // instead of being discovered after the fact.
  const costAlertMonitor = config.costAlertThresholdUsd
    ? new CostAlertMonitor(config.costAlertThresholdUsd, (stagePercent, costUsd, thresholdUsd) => {
        const message = `💰 Estimated cost has reached ${Math.round(stagePercent * 100)}% of your $${thresholdUsd} threshold ($${costUsd.toFixed(2)} so far, all-time).`;
        console.warn(`[jarvis] COST ALERT: ${message}`);
        activityLog.record(message);
        if (telegramGateway && config.telegramOwnerChatId) {
          telegramGateway.sendMessage(config.telegramOwnerChatId, message).catch((error) => {
            console.error("[jarvis] Failed to push cost alert to Telegram:", error);
          });
        }
      })
    : undefined;

  // Always registered, unlike the Telegram-only tools above — the
  // generated image's URL is useful on any channel (the tool result
  // itself always carries it); Telegram delivery on top is a bonus when
  // a owner chat happens to be configured, not a requirement.
  const pollinationsImageClient = new PollinationsImageClient();
  // Optional, better-quality image generation: Cloudflare Workers AI's
  // flux-1-schnell, reusing the exact same CLOUDFLARE_ACCOUNT_ID/
  // CLOUDFLARE_API_TOKEN already required for CloudflareWorkersAIBrain —
  // no separate credential to configure. Only the account id/token are
  // required here (unlike CloudflareWorkersAIBrain, which also requires an
  // explicit CLOUDFLARE_MODEL): CloudflareImageClient always targets
  // flux-1-schnell, so there's no per-user model choice to make for images
  // the way there is for 50+ general-purpose text models. See
  // GenerateImageTool's own doc comment for why this — not Gemini's
  // paid-tier-only image models — is the "better than Pollinations" option
  // actually wired in here.
  const cloudflareImageClient =
    config.cloudflareAccountId && config.cloudflareApiToken
      ? new CloudflareImageClient(config.cloudflareAccountId, config.cloudflareApiToken)
      : undefined;
  toolRegistry.registerTool(
    createGenerateImageTool(pollinationsImageClient, telegramGateway, config.telegramOwnerChatId, cloudflareImageClient)
  );
  permissionService.grant(DEFAULT_USER_ID, "GENERATE_IMAGE");

  // Registered here rather than alongside the other Canva tools above
  // (near createCreateCanvaDesignTool) because it needs telegramGateway,
  // which isn't constructed until this point in setup — same reasoning as
  // GENERATE_IMAGE just above it. READ-tier, so no explicit
  // permissionService.grant needed (see ExportCanvaDesignTool's own doc
  // comment).
  if (canvaClient) {
    toolRegistry.registerTool(createExportCanvaDesignTool(canvaClient, telegramGateway, config.telegramOwnerChatId));
  }

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
      contextProvider: (message) =>
        buildContextNote(
          config,
          reminderStore,
          calendarClient,
          commitmentStore,
          { goalStore, taskStore: agentTaskStore, userId: DEFAULT_USER_ID },
          behaviorCorrectionStore,
          message,
          githubActivityStore,
          newsWatchContext,
          gmailWatchContext,
          selfImprovementStore
        ),
      lockdownService,
      toolResultCache,
      embeddingsClient,
      memoryExtractor,
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
    // Twilio only sends call-status webhooks for an API-placed call when
    // StatusCallback is explicitly set on that call — unlike an inbound
    // call, it's never inherited from the number's own Voice URL config.
    // Without this, handleCallEnded() (wired to /voice/status) would never
    // fire for a wake-up call, leaking its PhoneSession/turnCount entry in
    // TwilioVoiceGateway for the life of the process.
    const wakeUpStatusCallbackUrl = new URL("/voice/status", config.twilioPublicBaseUrl!).toString();

    // Same account/credentials as outboundCaller above — reuses the same
    // "outbound call" config group since SMS needs exactly the same
    // Twilio fields (account sid, auth token, from number) plus somewhere
    // to send to (ownerPhoneNumber).
    const smsSender = new TwilioSmsSender(config.twilioAccountSid!, config.twilioAuthToken!, config.twilioFromNumber!);
    const smsSendGuard = new TwilioCostGuard(config.maxSmsPerDay);
    toolRegistry.registerTool(
      createSendSmsTool(smsSender, config.ownerPhoneNumber!, smsSendGuard, () => formatDateKey(new Date(), config.timezone))
    );
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
          .placeCall(config.ownerPhoneNumber!, wakeUpTwimlUrl, wakeUpStatusCallbackUrl)
          .then(() => {
            wakeUpCallStore.markTriggered(call.id, todayDateStr);
            activityLog.record(`Placed wake-up call${call.label ? ` (${call.label})` : ""}`);
          })
          .catch((error) => {
            // The consumed slot was for a call that never actually went
            // out — refund it so a transient Twilio failure doesn't burn
            // real quota and falsely block every subsequent wake-up call
            // for the rest of the day.
            outboundCallCostGuard.release(todayDateStr);
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
    // Guards against two ticks starting a send concurrently — setInterval
    // fires on a fixed wall-clock schedule regardless of whether the
    // previous tick's async work (the Telegram send here) has resolved
    // yet, and lastWeeklyDigestDateKey is only committed once that send
    // succeeds. Without this, a slow send straddling a tick boundary
    // would let a second tick see the same "not sent yet" state and send
    // the digest twice. Same in-flight-guard pattern the automation-rule
    // and wake-up-call schedulers already use.
    let sendInFlight = false;
    weeklyDigestInterval = setInterval(() => {
      schedulerHealthTracker.tick("weeklyDigest");
      if (sendInFlight) return;
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

      const cost = estimateCostUsd(tokenUsageStore.totals(), DEFAULT_MODEL);
      const message = formatWeeklyDigest(toolAuditLog.summary(), tokenUsageStore.totals(), cost);
      // Only marked sent once Telegram confirms the send — otherwise a
      // transient failure permanently skips that week's digest, since
      // isWeeklyDigestDue never re-captures the same dateKey (same "mark
      // before an operation that can fail" bug already fixed for reminder
      // notifications).
      sendInFlight = true;
      telegramGateway!
        .sendMessage(config.telegramOwnerChatId!, message)
        .then(() => {
          lastWeeklyDigestDateKey = todayDateKey;
        })
        .catch((error) => {
          console.error(
            "[jarvis] failed to send weekly digest (will retry next tick):",
            error instanceof Error ? error.message : String(error)
          );
        })
        .finally(() => {
          sendInFlight = false;
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

    // Same in-flight guard as the weekly digest above — a send straddling
    // a tick boundary would otherwise let a second tick see
    // checkinSentSinceLastInteraction still false and send the check-in
    // twice.
    let sendInFlight = false;
    checkinInterval = setInterval(() => {
      schedulerHealthTracker.tick("checkin");
      if (sendInFlight) return;
      if (!isCheckinDue(new Date(), lastInteractionAt, config.checkinAfterHours!, checkinSentSinceLastInteraction)) {
        return;
      }

      const hours = Math.round((Date.now() - lastInteractionAt.getTime()) / 3_600_000);
      const message = `Haven't heard from you in about ${hours} hours — just checking in.`;
      // Only marked sent once Telegram confirms the send — a failed send
      // otherwise leaves the flag true anyway, so isCheckinDue silently
      // never fires again for that idle period, defeating the whole point
      // of a check-in (same bug class already fixed for reminders/digest).
      sendInFlight = true;
      telegramGateway!
        .sendMessage(config.telegramOwnerChatId!, message)
        .then(() => {
          checkinSentSinceLastInteraction = true;
        })
        .catch((error) => {
          console.error(
            "[jarvis] failed to send check-in (will retry next tick):",
            error instanceof Error ? error.message : String(error)
          );
        })
        .finally(() => {
          sendInFlight = false;
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
    // Guards against two ticks running sendMorningBriefing concurrently.
    // The interval callback is async but setInterval never waits for a
    // previous invocation to settle before firing the next one on
    // schedule — sendMorningBriefing does several sequential network
    // calls (weather, calendar, Gmail, then the Telegram send itself),
    // and lastMorningBriefingDateKey/pendingMorningBriefingDateKey are
    // only committed after it resolves. Without this, a slow run
    // straddling a 30s tick boundary would let the next tick see the
    // same "not sent yet" state and send the briefing twice. Same
    // in-flight-guard pattern the automation-rule and wake-up-call
    // schedulers already use.
    let sendInFlight = false;

    async function sendMorningBriefing(now: Date): Promise<void> {
      const weather = await weatherClient?.getCurrentWeather().catch(() => undefined);
      const todaysEvents = calendarClient ? await calendarClient.listUpcomingEvents(10).catch(() => []) : [];
      const nowIso = now.toISOString();
      const dueOrOverdueReminders = reminderStore.list().filter((r) => r.dueAt !== null && r.dueAt <= nowIso);
      const unreadEmailCount = gmailClient ? await gmailClient.getMessageCount("is:unread").catch(() => undefined) : undefined;

      const message = formatMorningBriefing(weather, todaysEvents, dueOrOverdueReminders, unreadEmailCount);
      // Deliberately not caught here — the caller needs to know whether
      // the send actually succeeded, so it only commits
      // lastMorningBriefingDateKey/clears pendingMorningBriefingDateKey on
      // real success and retries on the next tick otherwise (same "mark
      // before an operation that can fail" bug already fixed for
      // reminders/digest/check-in).
      await telegramGateway!.sendMessage(config.telegramOwnerChatId!, message);
    }

    morningBriefingInterval = setInterval(async () => {
      schedulerHealthTracker.tick("morningBriefing");
      if (sendInFlight) return;
      const now = new Date();
      const nowTimeOfDay = formatTimeOfDay(now, config.timezone);
      const todayDateKey = formatDateKey(now, config.timezone);
      const quiet = isSuppressibleByQuietHours("morning_briefing") && isQuietHours(nowTimeOfDay, quietHoursWindow);

      if (isMorningBriefingDue(config.morningBriefingTime!, nowTimeOfDay, todayDateKey, lastMorningBriefingDateKey)) {
        if (quiet) {
          // Queued: nothing sent now, but flushed below the first time a
          // later tick lands outside the quiet-hours window. A plain
          // variable assignment can't fail the way a real send can, so
          // marking it captured immediately here is safe — it just stops
          // isMorningBriefingDue from re-capturing the same day again
          // while still in quiet hours.
          lastMorningBriefingDateKey = todayDateKey;
          pendingMorningBriefingDateKey = todayDateKey;
        } else {
          sendInFlight = true;
          try {
            await sendMorningBriefing(now);
            lastMorningBriefingDateKey = todayDateKey;
          } catch (error) {
            console.error(
              "[jarvis] failed to send morning briefing (will retry next tick):",
              error instanceof Error ? error.message : String(error)
            );
          } finally {
            sendInFlight = false;
          }
        }
        return;
      }

      if (pendingMorningBriefingDateKey === todayDateKey && !quiet) {
        sendInFlight = true;
        try {
          await sendMorningBriefing(now);
          pendingMorningBriefingDateKey = null;
        } catch (error) {
          console.error(
            "[jarvis] failed to send queued morning briefing (will retry next tick):",
            error instanceof Error ? error.message : String(error)
          );
        } finally {
          sendInFlight = false;
        }
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
  const pendingQuietAutomationPushes: Array<{ ruleId: string; message: string }> = [];
  const automationRuleInterval = setInterval(() => {
    schedulerHealthTracker.tick("automationRules");
    const now = new Date();
    const nowTimeOfDay = formatTimeOfDay(now, config.timezone);
    const todayDateKey = formatDateKey(now, config.timezone);
    const quiet = isSuppressibleByQuietHours("automation_rule_result") && isQuietHours(nowTimeOfDay, quietHoursWindow);

    if (!quiet && pendingQuietAutomationPushes.length > 0 && telegramGateway && config.telegramOwnerChatId) {
      for (const queued of pendingQuietAutomationPushes.splice(0)) {
        // Keyed by ruleId, not just message text — two unrelated rules can
        // easily produce the same reply text (e.g. both say "Nothing new."),
        // and content-only keys would let one rule's push silently suppress
        // another's within the same window.
        if (notificationDedup.shouldSend(`automation-push:${queued.ruleId}:${queued.message}`)) {
          telegramGateway.sendMessage(config.telegramOwnerChatId, queued.message).catch(() => {
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
              pendingQuietAutomationPushes.push({ ruleId: rule.id, message: reply });
            } else if (notificationDedup.shouldSend(`automation-push:${rule.id}:${reply}`)) {
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
                `⚠️ An automation rule failed (errorId ${errorId}): "${rule.instruction.slice(0, 100)}". Check the logs or /automation-failures for details.`
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
  // Guards against the same reminder being sent twice: setInterval fires
  // every 30s regardless of whether the previous tick's sendMessage calls
  // have resolved yet, and markNotified only runs once a send actually
  // succeeds (see below) — so a slow/rate-limited Telegram send still in
  // flight when the next tick's getDueUnnotified() runs would otherwise
  // find the same reminder (notified_at still null) and fire a second
  // send for it before the first one's .then() clears it. Same
  // in-flight-id-set pattern staleCommitmentInterval below already uses.
  // How long a device is given to reply (with no wake phrase required —
  // see ProactiveAnnouncer/WakeWordListener.speakProactiveAnnouncement)
  // before a proactive announcement counts as unanswered.
  const PROACTIVE_REPLY_WINDOW_MS = 20_000;
  const inFlightReminderIds = new Set<string>();
  const reminderNotificationInterval = setInterval(() => {
    schedulerHealthTracker.tick("reminderNotifications");
    const now = new Date();
    const nowIso = now.toISOString();
    if (isSuppressibleByQuietHours("reminder") && isQuietHours(formatTimeOfDay(now, config.timezone), quietHoursWindow)) return;
    const due = reminderStore.getDueUnnotified(nowIso).filter((r) => !inFlightReminderIds.has(r.id));

    for (const reminder of due) {
      const message = `⏰ Reminder: ${reminder.text}`;

      // Device-targeted live spoken reminders (CLAUDE.md wishlist #19):
      // an `announce` reminder with at least one currently-connected
      // target device gets spoken aloud instead of (not in addition to)
      // the silent push/Telegram path below — "device must be powered on"
      // (per the spec) is exactly what resolveAnnounceTargets returning
      // nothing means, and in that case this falls straight through to
      // the existing push/Telegram behavior unchanged, so an announce
      // reminder never gets silently lost just because the device happens
      // to be off right now.
      if (reminder.announce) {
        const targets = resolveAnnounceTargets(reminder.targetDevice, deviceRegistry, deviceConnectionManager);
        if (targets.length > 0) {
          inFlightReminderIds.add(reminder.id);
          // Marked notified immediately: the speech itself is the
          // delivery (unlike Telegram, there's no "confirmed sent"
          // signal to wait on beyond the WebSocket send not throwing,
          // which ProactiveAnnouncer already treats as "no response"
          // rather than an error) — the follow-up engine below is what
          // actually tracks whether the owner engaged with it.
          reminderStore.markNotified(reminder.id, nowIso);
          activityLog.record(`Reminder announced on ${targets.length} device(s): ${reminder.text.slice(0, 100)}`);
          const announceText = composeAnnouncementText(reminder.text, reminder.tone, false);
          Promise.all(targets.map((deviceId) => proactiveAnnouncer.announce(deviceId, announceText, PROACTIVE_REPLY_WINDOW_MS)))
            .then((results) => {
              if (results.some((r) => r.authenticated)) {
                reminderStore.markAcknowledged(reminder.id, new Date().toISOString());
                activityLog.record(`Reminder announcement acknowledged: ${reminder.text.slice(0, 100)}`);
              }
            })
            .catch((error) => {
              console.error(`[jarvis] proactive announcement failed for reminder ${reminder.id}:`, error);
            })
            .finally(() => {
              inFlightReminderIds.delete(reminder.id);
            });
          continue;
        }
      }

      // Native on-device push, independent of Telegram being configured
      // at all — a paired Mac already has everything this needs, no
      // separate bot/account setup required. Deliberately not gated on:
      // DeviceConnectionManager.sendNotification is itself silent
      // best-effort by design (no delivery confirmation to wait on), so
      // there's nothing reliable here to condition markNotified on.
      const primaryDevice = deviceRegistry.getPrimaryDevice();
      if (primaryDevice) {
        deviceConnectionManager.sendNotification(primaryDevice.id, "JARVIS Reminder", reminder.text);
      }

      if (telegramGateway && config.telegramOwnerChatId) {
        // markNotified only fires once Telegram confirms the send — a
        // reminder is otherwise the exact "silently lost forever" failure
        // mode UNDO_LAST_ACTION had: getDueUnnotified() filters on
        // notified_at, so marking it before delivery is known to have
        // worked means a transient Telegram hiccup (rate limit, expired
        // token, a blip) permanently drops the alert with no retry and no
        // sign anything went wrong. Leaving notified_at unset lets the
        // next 30s tick just try again.
        inFlightReminderIds.add(reminder.id);
        telegramGateway
          .sendMessage(config.telegramOwnerChatId, message)
          .then(() => {
            reminderStore.markNotified(reminder.id, nowIso);
            activityLog.record(`Reminder notification sent: ${reminder.text.slice(0, 100)}`);
          })
          .catch((error) => {
            console.error(
              "[jarvis] failed to send reminder notification (will retry next tick):",
              error instanceof Error ? error.message : String(error)
            );
          })
          .finally(() => {
            inFlightReminderIds.delete(reminder.id);
          });
      } else {
        // No Telegram configured — the on-device push above is the only
        // channel, and it has no reliable success signal by design, so
        // there's nothing better to gate on than firing it and moving on.
        reminderStore.markNotified(reminder.id, nowIso);
        activityLog.record(`Reminder notification sent: ${reminder.text.slice(0, 100)}`);
      }
    }
  }, 30_000);

  // Bounded follow-up ("did you do it?") engine for `announce` reminders —
  // CLAUDE.md wishlist #19: "If he doesn't respond, JARVIS should follow
  // up ... rather than firing once and moving on." Same setInterval +
  // in-flight-id-set pattern as the schedulers around it. Only ever
  // attempts a follow-up when a target device is actually reachable right
  // now (resolveAnnounceTargets) — a reminder whose device stayed
  // disconnected the whole time simply waits at its current followUpCount
  // rather than burning its bounded follow-up budget on attempts that
  // never reached anyone.
  const inFlightFollowUpIds = new Set<string>();
  const announceFollowUpInterval = setInterval(() => {
    schedulerHealthTracker.tick("announceFollowUps");
    const nowIso = new Date().toISOString();
    if (isSuppressibleByQuietHours("reminder") && isQuietHours(formatTimeOfDay(new Date(), config.timezone), quietHoursWindow)) {
      return;
    }
    const needingFollowUp = getAnnounceFollowUps(reminderStore.list(), nowIso, inFlightFollowUpIds);

    for (const reminder of needingFollowUp) {
      const targets = resolveAnnounceTargets(reminder.targetDevice, deviceRegistry, deviceConnectionManager);
      if (targets.length === 0) continue;

      inFlightFollowUpIds.add(reminder.id);
      reminderStore.recordFollowUpAttempt(reminder.id, nowIso);
      const followUpText = composeAnnouncementText(reminder.text, reminder.tone, true);
      Promise.all(targets.map((deviceId) => proactiveAnnouncer.announce(deviceId, followUpText, PROACTIVE_REPLY_WINDOW_MS)))
        .then((results) => {
          if (results.some((r) => r.authenticated)) {
            reminderStore.markAcknowledged(reminder.id, new Date().toISOString());
            activityLog.record(`Reminder follow-up acknowledged: ${reminder.text.slice(0, 100)}`);
          } else {
            activityLog.record(`Reminder follow-up sent (no confirmed reply): ${reminder.text.slice(0, 100)}`);
          }
        })
        .catch((error) => {
          console.error(`[jarvis] proactive follow-up failed for reminder ${reminder.id}:`, error);
        })
        .finally(() => {
          inFlightFollowUpIds.delete(reminder.id);
        });
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
    schedulerHealthTracker.tick("staleCommitments");
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
    proactiveAnnouncer,
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
    canvaClient,
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
    toolResultCacheForAdmin: toolResultCache,
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
    autoGrantToolIdsOnApproval: AUTO_GRANTED_ON_APPROVAL_TOOLS,
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

  eventBus.on("tool.executed", ({ toolName, result, userId, input, toolCallId, runId }) => {
    toolAuditLog.record(toolName, userId, input, result, { toolCallId, runId });
    activityLog.record(`${toolName} → ${result.success ? "ok" : `failed: ${result.error}`}`);
  });

  // Persists every JarvisLiveState transition (see
  // src/core/state/JarvisLiveState.ts) so "what was JARVIS doing a few
  // minutes ago" is answerable per-session, not just "what is it doing
  // right now" — GET /agent-recent-activity reads this back.
  eventBus.on("jarvis.liveState.changed", ({ sessionId, userId, from, to, reason, language, timestamp }) => {
    toolAuditLog.recordLiveStateTransition({ sessionId, userId, from, to, reason, language, timestamp });
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
  if ((phoneGateway || smsGateway) && (!config.twilioAllowedCallers || config.twilioAllowedCallers.length === 0)) {
    const channels = [phoneGateway && "calls", smsGateway && "texts"].filter(Boolean).join(" and ");
    console.warn(
      `[jarvis] WARNING: phone/SMS gateway is running open (TWILIO_ALLOW_OPEN_ACCESS=true, no ` +
        `TWILIO_ALLOWED_CALLERS) — anyone who ${channels} the configured number reaches full JARVIS, ` +
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
    confirmationPassphraseStore.close();
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
    clearInterval(announceFollowUpInterval);
    clearInterval(automationRuleInterval);
    clearInterval(agentQueueInterval);
    agentTaskStore.close();
    goalStore.close();
    githubActivityStore.close();
    if (githubActivityInterval) clearInterval(githubActivityInterval);
    if (newsWatcherScheduler) newsWatcherScheduler.stop();
    newsWatcherStore.close();
    if (gmailWatcherScheduler) gmailWatcherScheduler.stop();
    gmailWatcherStore.close();
    if (selfImprovementScheduler) selfImprovementScheduler.stop();
    selfImprovementStore.close();
    calendarTokenStore.close();
    spotifyTokenStore.close();
    canvaTokenStore.close();
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
