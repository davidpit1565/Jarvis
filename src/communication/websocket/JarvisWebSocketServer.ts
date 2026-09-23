import type { Server, ServerWebSocket } from "bun";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { writeFileSync, unlinkSync } from "node:fs";
import packageJson from "../../../package.json";
import type { EventBus } from "@/core/events/EventBus";
import type { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import type { PairingService } from "@/devices/pairing/PairingService";
import type { ToolRegistry } from "@/tools/registry/ToolRegistry";
import type { ActivityLog } from "@/core/activity/ActivityLog";
import type { TokenUsageStore } from "@/audit/TokenUsageStore";
import { estimateCostUsd } from "@/audit/estimateCostUsd";
import { DEFAULT_MODEL } from "@/core/brain/ClaudeBrain";
import { createBackupArchive } from "@/backup/createBackupArchive";
import type { ReminderStore } from "@/reminders/ReminderStore";
import type { MemoryStore } from "@/memory/MemoryStore";
import type { ToolAuditLog } from "@/audit/ToolAuditLog";
import type { ConversationHistoryStore } from "@/history/ConversationHistoryStore";
import type { GoogleCalendarClient } from "@/calendar/GoogleCalendarClient";
import type { UserMessageImage } from "@/types/conversation";
import type { SpotifyClient } from "@/spotify/SpotifyClient";
import type { WakeUpCallStore } from "@/wakeup/WakeUpCallStore";
import type { PermissionService } from "@/permissions/PermissionService";
import type { Orchestrator } from "@/core/orchestrator/Orchestrator";
import { DeviceConnectionManager, type DeviceConnection } from "./DeviceConnectionManager";
import type { TwilioVoiceGateway } from "@/communication/phone/TwilioVoiceGateway";
import type { TwilioSmsGateway } from "@/communication/phone/TwilioSmsGateway";
import type { TelegramGateway } from "@/communication/telegram/TelegramGateway";
import type { DeviceVoiceGateway } from "@/communication/voice/DeviceVoiceGateway";
import type { LockdownService } from "@/core/lockdown/LockdownService";
import type { AutomationRuleStore } from "@/automation/AutomationRuleStore";
import type { CostTracker } from "@/core/cost/CostTracker";
import type { ToolResultCache } from "@/core/cache/ToolResultCache";
import type { JarvisLiveStateTracker } from "@/core/state/JarvisLiveState";
import { verifyTwilioSignature } from "@/communication/phone/twilioSignature";
import { DASHBOARD_HTML, LOCK_HTML } from "./dashboard";
import type { WebAuthnService } from "@/auth/WebAuthnService";
import type { SessionStore } from "@/auth/SessionStore";
import { AudioLevelBroadcaster } from "./AudioLevelBroadcaster";
import { RateLimiter } from "./RateLimiter";
import type { AIRouter } from "@/core/brain/AIRouter";
import type { SchedulerHealthTracker } from "@/core/health/SchedulerHealthTracker";
import type { AutomationFailureStore } from "@/automation/AutomationFailureStore";
import { redactConfigForDisplay, type JarvisConfig } from "@/config";
import { verifyDatabaseIntegrity } from "@/backup/verifyBackupIntegrity";
import { Logger } from "@/core/logging/Logger";
import { computeAudioLevel } from "@/communication/phone/audioLevel";
import { computeTurnLatencies } from "@/core/state/turnLatency";
import {
  makeEnvelope,
  parseDeviceToCoreMessage,
  type DeviceRegisterMessage,
  type ToolResultMessage,
} from "./protocol";

type SocketData =
  // `connection` is the exact DeviceConnection object registered with
  // DeviceConnectionManager for this specific socket — carried so the
  // close handler can tell DeviceConnectionManager "remove this only if
  // it's still the one you have registered", not just "remove whatever's
  // registered for this deviceId" (see DeviceConnectionManager.removeConnection's
  // doc comment for why that distinction matters on a stale reconnect race).
  | { kind: "device"; deviceId: string | null; ip: string | null; connection?: DeviceConnection }
  // Read-only spectator on /observer (e.g. the hologram UI) — never part
  // of the device protocol, just mirrored every EventBus event.
  | { kind: "observer" }
  | { kind: "audio-ingest" }
  | { kind: "audio-viewer" }
  // A real two-way text conversation with JARVIS from a browser (the
  // hologram UI's own chat box) — distinct from "observer" (read-only
  // telemetry) and from the phone gateway (its own per-call Orchestrator).
  // Shares the ONE web-chat Orchestrator across every connection, same
  // "single user, one ongoing conversation" model the CLI loop already
  // uses, rather than a fresh throwaway conversation per browser tab.
  | { kind: "web-chat" };

type DeviceSocket = ServerWebSocket<Extract<SocketData, { kind: "device" }>>;
type BunServer = Server<SocketData>;

/** Every EventBus event this server will mirror out to observer sockets. */
const OBSERVABLE_EVENTS = [
  "conversation.message",
  "brain.request",
  "brain.response",
  "tool.requested",
  "tool.executed",
  "tool.dispatched",
  "permission.checked",
  "device.registered",
  "device.connected",
  "device.disconnected",
  // Forwards JARVIS's user-facing live state (LISTENING/THINKING/EXECUTING/
  // SPEAKING/…) to observer clients — see the doc comment on
  // "jarvis.liveState.changed" in src/types/events.ts. Roadmap items 92-97/
  // 101-103 and the UI half of item 36: this is the one-line addition that
  // comment says was intentionally deferred, now wired so the hologram UI
  // can show a real state indicator instead of a fake one.
  "jarvis.liveState.changed",
  // Forwards AgentCore task state transitions (with their safe `phase`
  // field — see src/agent/AgentTaskStateMachine.ts's phaseForAgentTaskState
  // and the doc comment on "agent.task.transition" in src/types/events.ts)
  // so an observer client can render a real, truthful execution timeline
  // for an autonomous task, not just the collapsed live-state indicator.
  "agent.task.transition",
  // Real provider-fallback events (AIRouter actually switched providers —
  // see the doc comment on "ai.providerFallback" in src/types/events.ts)
  // forwarded so an observer client (the Command Center's Live Agent
  // Monitor) can show an honest "switched providers" notice only when a
  // real fallback fired, never a fabricated one.
  "ai.providerFallback",
  // Real model-escalation retries (AIRouter actually retried against a
  // stronger provider after a deterministic validity check rejected the
  // first response — see the doc comment on "ai.escalation" in
  // src/types/events.ts) — same rationale as ai.providerFallback above, so
  // the Command Center's Live Agent Monitor can show an honest "escalated
  // to a stronger model" notice only when a real escalation fired.
  "ai.escalation",
] as const;

export interface JarvisWebSocketServerDependencies {
  deviceRegistry: DeviceRegistry;
  deviceConnectionManager: DeviceConnectionManager;
  pairingService: PairingService;
  eventBus: EventBus;
  /** Optional: enables tool names/targets in the GET /status feed (dashboard and hologram UI both poll it). */
  toolRegistry?: ToolRegistry;
  /** Optional: recent activity feed shown on the dashboard. */
  activityLog?: ActivityLog;
  /** All three required together to enable the Twilio phone gateway; otherwise its routes 404. */
  phoneGateway?: TwilioVoiceGateway;
  /**
   * Enables POST /sms/incoming, gated on the exact same twilioAuthToken/
   * twilioPublicBaseUrl as the phone gateway — texting rides the same
   * Twilio number, no separate config.
   */
  smsGateway?: TwilioSmsGateway;
  twilioAuthToken?: string;
  twilioPublicBaseUrl?: string;
  /**
   * E.164 phone numbers allowed to reach JARVIS by phone. When set and
   * non-empty, any other caller is politely turned away before reaching
   * the Orchestrator. When unset, any caller who knows the number reaches
   * the full assistant — the phone number itself is then the only gate.
   */
  twilioAllowedCallers?: string[];
  /**
   * Shared secret required on POST /pairing/approve, via the
   * X-Jarvis-Admin-Token header. Without this, the pairing code itself is
   * the only thing standing between a self-registered device and a valid
   * credential — and that code is handed back to whoever requested it, so
   * an attacker who registers a fake device can read its own code and
   * immediately self-approve. Required whenever this server is reachable
   * from the public internet (i.e. the phone gateway is configured, since
   * both share this same Bun.serve process); optional for purely local
   * development.
   */
  adminToken?: string;
  /**
   * Optional Face ID / Touch ID (WebAuthn) protection for the dashboard.
   * Both required together: once any credential is registered, GET / and
   * GET /dashboard require a valid session (issued by POST /auth/login)
   * instead of serving the page directly. Registering the first credential
   * requires `adminToken` (see above), so setup can't be hijacked by
   * whoever happens to load the page first.
   */
  webAuthnService?: WebAuthnService;
  sessionStore?: SessionStore;
  /**
   * When set, enables live phone-call audio level broadcasting: Twilio
   * streams raw call audio to POST-upgraded GET /voice/audio-stream, and
   * any browser connected to GET /dashboard/audio-ws receives a live
   * amplitude feed for a waveform visualization. Absent means the feature
   * is off and /voice/audio-stream 404s — this is a real extra Twilio
   * cost (~$0.004/min on top of call minutes), so it's opt-in.
   */
  audioLevelBroadcaster?: AudioLevelBroadcaster;
  /** Optional: exposes real token usage + estimated cost in GET /status. */
  tokenUsageStore?: TokenUsageStore;
  /**
   * Every SQLite database file path this instance is configured to use.
   * When set alongside `adminToken`, enables GET /backup: an admin-gated
   * download of all of them as one gzip'd tar, for actual disaster
   * recovery. Without an admin token configured, /backup always 404s —
   * this dumps everything including paired-device and WebAuthn
   * credentials, so it must never be reachable without one.
   */
  backupDbPaths?: string[];
  /** Optional: enables the admin-gated GET /reminders read-only endpoint. */
  reminderStore?: ReminderStore;
  /** Optional: enables the admin-gated GET /memory read-only endpoint. */
  memoryStore?: MemoryStore;
  /** Optional: exposes a tool-usage summary (most-used tool, error rate) in GET /status. */
  toolAuditLog?: ToolAuditLog;
  /** Optional: exposes a conversation-history turn count in GET /status. */
  conversationHistoryStore?: ConversationHistoryStore;
  /**
   * Directory the SQLite databases actually live in. When set, GET /health
   * does a real write+delete test against it on every check, so a full or
   * unwritable data volume shows up as `status: "degraded"` (HTTP 503)
   * instead of every store's writes silently failing while Fly.io's health
   * check keeps reporting the machine as fine. Omit for :memory: setups
   * (tests, local dev without persistence) where there's no disk to check.
   */
  dataDirectory?: string;
  /**
   * Optional: enables GET /calendar/oauth/start and /calendar/oauth/callback,
   * which link a Google account for read-only Calendar access. When unset,
   * both routes 404.
   */
  calendarClient?: GoogleCalendarClient;
  /**
   * Optional: enables GET /spotify/oauth/start and /spotify/oauth/callback,
   * which link a Spotify account for playback control. When unset, both
   * routes 404.
   */
  spotifyClient?: SpotifyClient;
  /** Optional: enables the admin-gated GET /wakeup-calls read-only endpoint. */
  wakeUpCallStore?: WakeUpCallStore;
  /**
   * Both required together to enable POST /telegram/webhook; otherwise it
   * 404s. `telegramWebhookSecret` must match the `X-Telegram-Bot-Api-Secret-Token`
   * header Telegram sends on every webhook request (configured via
   * setWebhook's own `secret_token` field) — without it, anyone who
   * discovers the webhook URL could inject fake "incoming messages."
   */
  telegramGateway?: TelegramGateway;
  telegramWebhookSecret?: string;
  /**
   * Optional: enables the "Hey JARVIS" wake-word voice channel. When set,
   * a `voice.transcript` message from a paired device is routed through
   * it and any spoken-back reply is sent as `voice.reply`. Without it,
   * `voice.transcript` messages are silently ignored (same shape as
   * `event`'s current no-op handling).
   */
  deviceVoiceGateway?: DeviceVoiceGateway;
  /**
   * Optional break-glass kill switch. When set, enables POST
   * /emergency/lockdown and POST /emergency/lockdown/lift (both admin-token
   * gated) and includes lockdown status in GET /status. Without it, both
   * routes 404 and the feature doesn't exist for this instance.
   */
  lockdownService?: LockdownService;
  /**
   * Approving a device's pairing (an explicit, deliberate human action —
   * running `bun run approve-device`) is the one moment this codebase
   * already treats as "I trust this specific device." When set, that same
   * moment also grants the device-scoped tools listed in
   * `autoGrantToolIdsOnApproval` to `defaultUserId` on that device —
   * otherwise a SAFE_ACTION/CONFIRM device tool would be permanently
   * unusable (PermissionService denies any non-READ tool with no grant,
   * and there is no other point in this single-user system where a
   * device-scoped grant could be issued, since the device's id isn't
   * known until it registers). Both required together; omit both to
   * leave every non-READ device tool ungranted, as before this existed.
   */
  permissionService?: PermissionService;
  defaultUserId?: string;
  autoGrantToolIdsOnApproval?: string[];
  /**
   * Enables a real two-way text conversation at ws(s)://.../chat — the
   * hologram UI's chat box sends a line, gets JARVIS's real response back,
   * the same `orchestrator.handleUserMessage()` call the CLI loop and the
   * phone gateway already use. Absent means /chat 404s (no silent
   * degrade — better an obvious "not available" than a socket that opens
   * and never answers). Gated by `adminToken` when one is configured (see
   * above) via a `?token=` query param, since unlike /observer this can
   * trigger real device actions and spend real API budget — anyone who
   * can open this URL should NOT automatically be able to talk to it once
   * it's on the public internet.
   */
  webChatOrchestrator?: Orchestrator;
  /**
   * Overrides the 45s default interval for the keepalive ping loop
   * (covers both authenticated devices and devices still pending pairing
   * approval). Test-only knob — real deployments should never set this.
   */
  pingIntervalMs?: number;
  /**
   * Optional: enables the admin-gated `GET /providers/health` read-only
   * endpoint, exposing `AIRouter.getProviderStatus()` (circuit-breaker
   * state, latency, success rate per configured AI provider) over HTTP
   * — see JARVIS_ROADMAP_AUDIT.md #174. Without it, the route 404s.
   */
  aiRouter?: AIRouter;
  /**
   * Optional: when set, `GET /status` includes a `schedulerHealth` array
   * (last-tick timestamp/age per named background scheduler) so a
   * scheduler that silently stopped firing is visible — see
   * JARVIS_ROADMAP_AUDIT.md #176. The caller (src/index.ts) owns the
   * instance and calls `.tick(name)` from each of its own `setInterval`
   * loops; this server only ever reads it.
   */
  schedulerHealthTracker?: SchedulerHealthTracker;
  /**
   * Optional: enables the admin-gated `GET /automation-failures`
   * read-only endpoint, a durable record of automation rule executions
   * that threw — see JARVIS_ROADMAP_AUDIT.md #177/#178. Without it, the
   * route 404s.
   */
  automationFailureStore?: AutomationFailureStore;
  /**
   * Optional: enables the admin-gated `GET /permissions` read-only
   * endpoint, listing every standing `(userId, toolId, deviceId)` grant
   * held by `PermissionService` — see JARVIS_ROADMAP_AUDIT.md #205
   * (Permission Management UI). Without it, the route 404s.
   */
  permissionServiceForAdmin?: PermissionService;
  /**
   * Optional: enables the admin-gated `GET /config` read-only endpoint —
   * the loaded `JarvisConfig`, with every secret-shaped field (API keys,
   * the admin token itself, webhook secrets, etc.) replaced by whether
   * it's set, never its real value — see JARVIS_ROADMAP_AUDIT.md #208
   * (Config Center). Without it, the route 404s.
   */
  jarvisConfig?: JarvisConfig;
  /**
   * Optional: enables the admin-gated `GET /automations` read-only
   * endpoint, listing every stored automation rule (id, schedule,
   * instruction, enabled state) — the Automation Explorer
   * (JARVIS_ROADMAP_AUDIT.md #190). Previously the rules themselves were
   * only reachable through the chat-invoked `LIST_AUTOMATION_RULES` tool;
   * this is a dedicated UI-facing view on top of the same store. Without
   * it, the route 404s.
   */
  automationRuleStoreForAdmin?: AutomationRuleStore;
  /**
   * Optional: enables the admin-gated `GET /cost-analytics` read-only
   * endpoint — today/week/month spend, breakdowns by provider/model/task
   * type, recent call records, measured prompt-cache effectiveness, and
   * (with `?runId=`) a single run's full unified-AI-Cost-Ledger rollup —
   * from `CostTracker` — the Cost Analytics panel (JARVIS_ROADMAP_AUDIT.md
   * #192, extended in batch 3). Without it, the route 404s.
   */
  costTrackerForAdmin?: CostTracker;
  /**
   * Optional: when set, `GET /cost-analytics` also includes
   * `toolResultCache` hit/miss stats (JARVIS_ROADMAP_AUDIT.md batch 3) —
   * the previously-ephemeral `tool.cacheHit` signal, now aggregated.
   * Independent of `costTrackerForAdmin`: the route still works (just
   * without this field) if only one of the two is configured.
   */
  toolResultCacheForAdmin?: ToolResultCache;
  /**
   * Optional: enables the admin-gated `GET /agent-status` read-only
   * endpoint (every live session's current JarvisLiveState snapshot —
   * the Live Agent Monitor / "what are you doing?" status,
   * JARVIS_ROADMAP_AUDIT.md #187/#195) and `POST /agent/stop` (calls
   * `webChatOrchestrator.requestStop(userId)` — the Stop button,
   * JARVIS_ROADMAP_AUDIT.md #196). Both require `webChatOrchestrator` to
   * also be set for `/agent/stop` to do anything; `/agent-status` only
   * needs this tracker. Without this, both routes 404.
   */
  liveStateTracker?: JarvisLiveStateTracker;
}

const SESSION_COOKIE = "jarvis_session";
const HOLOGRAM_ASSET_PATH = join(import.meta.dir, "assets", "hologram.jpg");
// Generous for a real, one-time, deliberate action (nobody takes 10
// minutes to click through Google's consent screen), short enough that
// an abandoned/repeated /calendar/oauth/start never leaves state entries
// accumulating for long.
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

// The full standalone hologram visualizer (ui/hologram/ — the "Core" HUD
// with its own README) used to only be opened as a local file (or from a
// throwaway `python3 -m http.server`), pointed at Core over ?host=&port=.
// Serving it directly from Core's own HTTP server at /hologram means a
// deployed, publicly-reachable Core can hand a phone (or any browser) a
// single URL that shows the real, live Core — same-origin, no query
// params needed (see coreOrigin() in ui/hologram/index.html). Three
// levels up from src/communication/websocket/ is the repo root.
const HOLOGRAM_UI_DIR = join(import.meta.dir, "..", "..", "..", "ui", "hologram");

// A separate, minimal admin panel (device approval/revocation,
// permissions, security events, emergency lockdown, config) — see
// JARVIS_ROADMAP_AUDIT.md #200/#205/#206/#207/#208. Deliberately its own
// static page under ui/admin/, never inside ui/hologram/: the hologram
// visual is off-limits to touch for any reason. Static shell only — it
// carries no secrets itself; every admin token check happens on the data
// endpoints it calls (GET /pairing/pending, /permissions, /config, etc.),
// exactly like the hologram UI's own /status polling.
const ADMIN_UI_DIR = join(import.meta.dir, "..", "..", "..", "ui", "admin");

// The Command Center (JARVIS_ROADMAP_AUDIT.md #186) — a second, separate
// static page distinct from both ui/admin/ (device/security/config
// operations) and ui/hologram/ (the always-off-limits hologram visual):
// this one aggregates the *data* views (live agent status, memory,
// automations, provider health, cost analytics) an operator actually
// checks day to day. Same additive pattern as ADMIN_UI_DIR — a static
// shell with no secrets of its own, every real check happening on the
// admin-token-gated data endpoints it calls.
const COMMAND_CENTER_UI_DIR = join(import.meta.dir, "..", "..", "..", "ui", "command-center");

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

/** Derives the origin/rpID WebAuthn ceremonies must match, from the request actually used to reach this server (works behind Fly's proxy via X-Forwarded-Proto, and on plain localhost for development). */
function getOriginAndRpID(req: Request, url: URL): { origin: string; rpID: string } {
  const host = req.headers.get("host") ?? url.host;
  const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return { origin: `${proto}://${host}`, rpID: host.split(":")[0]! };
}

/**
 * WebSocket transport for Core <-> device agents. Deliberately thin: all
 * routing/lifecycle decisions live in DeviceConnectionManager, DeviceRegistry,
 * and PairingService — this class only turns bytes into validated protocol
 * messages and back.
 */
export class JarvisWebSocketServer {
  /** Sockets that have sent device.register but aren't authenticated yet, keyed by deviceId. */
  private pendingConnections: Map<string, DeviceSocket> = new Map();
  /**
   * Guards the two endpoints with a brute-forceable secret behind them (a
   * pairing code, a WebAuthn assertion) — 10 attempts per 5 minutes per
   * (IP, route) is generous for a genuine user (nobody fat-fingers a
   * pairing code or retries a failed Face ID prompt 10 times in 5 minutes)
   * but far too slow to brute-force a 6-digit code or hammer verification.
   */
  private readonly rateLimiter = new RateLimiter(10, 5 * 60 * 1000);
  /**
   * OAuth `state` values issued by GET /calendar/oauth/start and not yet
   * redeemed, mapped to when they were issued — CSRF protection for the
   * callback, since Google's redirect carries no way to re-prove the
   * admin token that gated /start. Each value is single-use (removed once
   * redeemed) and expires after OAUTH_STATE_TTL_MS: an abandoned or
   * repeated /start (a probe, a retry) would otherwise leave entries
   * accumulating in memory forever, since nothing else ever removes an
   * unredeemed one. In-memory (not persisted) is fine regardless: a
   * restart mid-flow just means starting the link again, a rare,
   * deliberate, one-time action.
   */
  private readonly pendingOAuthStates: Map<string, number> = new Map();
  /** Same purpose/lifecycle as `pendingOAuthStates`, kept separate so the Spotify and Calendar OAuth flows never share state. */
  private readonly pendingSpotifyOAuthStates: Map<string, number> = new Map();

  /**
   * Read-only spectators connected on `/observer` (e.g. the hologram UI in
   * `ui/hologram/`) — never part of the device protocol, never trusted with
   * device.register/tool.result, just mirrored every EventBus event so a
   * human can watch what Core is actually doing in real time.
   */
  private observers: Set<ServerWebSocket<SocketData>> = new Set();

  /** Structured logger for this server's own reliability-relevant admin/health endpoints — see src/core/logging/Logger.ts. */
  private readonly logger = new Logger("http");

  /**
   * The currently connected /chat browser socket, if any — single slot,
   * not a Set, matching this project's "one owner" scale (same
   * simplification `ownerPhoneNumber`/`telegramOwnerChatId` already
   * make). Used by requestWebChatConfirmation() below so a CONFIRM/
   * DANGEROUS tool called via the hologram chat gets a real in-band
   * yes/no prompt instead of silently sharing the terminal's
   * `confirmViaChat` (which the browser can never see or answer) — the
   * same real gap Telegram's own `awaitConfirmation()` already closed
   * for that channel; this is the web-chat equivalent.
   */
  private activeWebChatSocket: ServerWebSocket<Extract<SocketData, { kind: "web-chat" }>> | undefined;
  private pendingWebChatConfirmation: ((answer: boolean) => void) | undefined;
  // The one socket a pending confirmation's prompt was actually sent to —
  // NOT necessarily the current activeWebChatSocket, since a new tab can
  // become active while an older, still-connected tab still holds an
  // unanswered prompt for a brief window (before that new tab's own
  // `open` deny-and-clear fires — see the `open` handler below). Without
  // this, handleWebChatMessage matched a yes/no reply from ANY connected
  // web-chat socket, not just the one that actually saw the prompt: a
  // second open tab (dashboard + hologram, or two browser windows) could
  // silently approve/deny a CONFIRM/DANGEROUS tool call it never
  // displayed, just by the user typing "yes" into it for something else.
  private pendingWebChatConfirmationSocket: ServerWebSocket<Extract<SocketData, { kind: "web-chat" }>> | undefined;

  constructor(private readonly deps: JarvisWebSocketServerDependencies) {
    this.subscribeObserverBroadcast();
  }

  private subscribeObserverBroadcast(): void {
    for (const eventName of OBSERVABLE_EVENTS) {
      this.deps.eventBus.on(eventName, (payload) => {
        this.broadcastToObservers(eventName, payload);
      });
    }
  }

  private broadcastToObservers(type: string, payload: unknown): void {
    if (this.observers.size === 0) return;
    const message = JSON.stringify({ type, payload, timestamp: new Date().toISOString() });
    for (const ws of this.observers) {
      ws.send(message);
    }
  }

  start(port: number) {
    const server = Bun.serve<SocketData>({
      port,
      fetch: async (req, server) => {
        const response = await this.route(req, server);
        // A WebSocket upgrade returns undefined by design (Bun owns the
        // response in that case) — only an actual HTTP response gets the
        // headers below.
        return response ? withSecurityHeaders(response) : undefined;
      },
      websocket: {
        // Without this, a connection whose TCP session died without a
        // clean close (network drop, laptop sleep, a Wi-Fi handoff) stays
        // "connected" from this server's point of view forever — the
        // device would show as online on the dashboard and JARVIS would
        // keep trying to dispatch device tools to it, with every one of
        // those calls only failing after its own separate timeout. Bun
        // closes an idle socket after this many seconds of no messages in
        // either direction, which fires the same `close` handler below
        // that already marks a device offline on a clean disconnect.
        idleTimeout: 120,
        open: (ws) => {
          const socket = ws as ServerWebSocket<SocketData>;
          if (socket.data.kind === "observer") {
            this.observers.add(socket);
          } else if (socket.data.kind === "audio-viewer") {
            this.deps.audioLevelBroadcaster?.addViewer(socket);
          } else if (socket.data.kind === "web-chat") {
            // A new tab/reconnect replaces the previous one as "active" —
            // any confirmation still pending against the old socket can
            // never be answered now, so deny it rather than leave it
            // hanging until its own 60s ConfirmationService timeout.
            this.pendingWebChatConfirmation?.(false);
            this.pendingWebChatConfirmation = undefined;
            this.pendingWebChatConfirmationSocket = undefined;
            this.activeWebChatSocket = socket as ServerWebSocket<Extract<SocketData, { kind: "web-chat" }>>;
          }
          // Device sockets: a no-op here — only meaningful once they register.
        },
        message: (ws, raw) => {
          const socket = ws as ServerWebSocket<SocketData>;
          if (socket.data.kind === "observer") return; // read-only channel, nothing to accept from it
          if (socket.data.kind === "audio-ingest") {
            this.handleAudioStreamMessage(raw.toString());
            return;
          }
          if (socket.data.kind === "audio-viewer") {
            return; // viewers are receive-only; nothing to act on
          }
          if (socket.data.kind === "web-chat") {
            this.handleWebChatMessage(ws as ServerWebSocket<Extract<SocketData, { kind: "web-chat" }>>, raw.toString());
            return;
          }
          this.handleMessage(socket as DeviceSocket, raw.toString());
        },
        close: (ws) => {
          const socket = ws as ServerWebSocket<SocketData>;
          if (socket.data.kind === "observer") {
            this.observers.delete(socket);
            return;
          }
          if (socket.data.kind === "device") {
            const deviceId = socket.data.deviceId;
            if (deviceId) {
              this.pendingConnections.delete(deviceId);
              // Passing this exact socket's own registered connection as
              // `expectedConnection` means a stale socket's delayed close
              // (network handoff/sleep — the device already reconnected
              // on a new socket before this one's TCP teardown fired)
              // can't tear down the newer, genuinely live connection —
              // see DeviceConnectionManager.removeConnection's doc comment.
              // Only marked offline when the disconnect actually applied —
              // otherwise this stale close would wrongly flag a device
              // that's still genuinely connected (on the newer socket) as
              // offline.
              const disconnected = this.deps.deviceConnectionManager.handleDisconnect(deviceId, "socket_closed", socket.data.connection);
              if (disconnected) {
                this.deps.deviceRegistry.updateStatus(deviceId, "offline");
              }
            }
          } else if (socket.data.kind === "audio-viewer") {
            this.deps.audioLevelBroadcaster?.removeViewer(socket);
          } else if (socket.data.kind === "web-chat") {
            if (this.activeWebChatSocket === socket) {
              this.activeWebChatSocket = undefined;
            }
            if (this.pendingWebChatConfirmationSocket === socket) {
              // Nobody left to answer THIS prompt — deny rather than leave
              // it hanging until ConfirmationService's own timeout.
              this.pendingWebChatConfirmation?.(false);
              this.pendingWebChatConfirmation = undefined;
              this.pendingWebChatConfirmationSocket = undefined;
            }
          }
        },
      },
    });

    // Keeps a genuinely healthy but quiet device connection (no tool
    // calls in a while) from being closed by the idleTimeout above: each
    // ping's real "pong" reply is itself socket activity. Well under
    // idleTimeout so a pong has time to arrive before the connection
    // would otherwise be considered idle. Cleared whenever the caller
    // stops the server — never left running past the server's own
    // lifetime (this matters most in tests, which start/stop many
    // short-lived servers).
    const pingInterval = setInterval(
      () => {
        this.deps.deviceConnectionManager.pingAll();
        this.pingPendingConnections();
      },
      this.deps.pingIntervalMs ?? 45_000
    );
    const originalStop = server.stop.bind(server);
    server.stop = ((...args: Parameters<typeof originalStop>) => {
      clearInterval(pingInterval);
      return originalStop(...args);
    }) as typeof server.stop;

    return server;
  }

  private async route(req: Request, server: BunServer): Promise<Response | undefined> {
    try {
          const url = new URL(req.url);

          if (req.method === "POST" && url.pathname === "/pairing/approve") {
            return await this.handleApproveHttp(req, server);
          }

          if (req.method === "POST" && url.pathname === "/pairing/revoke") {
            return await this.handleRevokeHttp(req, server);
          }

          if (req.method === "POST" && url.pathname === "/emergency/lockdown") {
            return await this.handleLockdownHttp(req, server, "activate");
          }

          if (req.method === "POST" && url.pathname === "/emergency/lockdown/lift") {
            return await this.handleLockdownHttp(req, server, "lift");
          }

          if (req.method === "POST" && url.pathname.startsWith("/voice/")) {
            return await this.handleVoiceWebhook(req, url);
          }

          if (req.method === "POST" && url.pathname === "/sms/incoming") {
            return await this.handleSmsWebhook(req, url);
          }

          if (req.method === "POST" && url.pathname === "/telegram/webhook") {
            return await this.handleTelegramWebhook(req, server);
          }

          // A WebSocket handshake is itself an HTTP GET with an Upgrade
          // header — device agents connect to "/", so these routes must
          // never intercept that or every device connection would break.
          const isUpgradeRequest = req.headers.get("upgrade")?.toLowerCase() === "websocket";

          // Deliberately unauthenticated and independent of everything else
          // (Face ID lock, admin token, phone gateway config) — a health
          // check has to keep working even if those are misconfigured,
          // since that's exactly the situation an uptime monitor or Fly.io
          // deploy health check needs to detect isn't a full outage.
          if (!isUpgradeRequest && req.method === "GET" && url.pathname === "/health") {
            const diskWritable = isDataDirectoryWritable(this.deps.dataDirectory);
            return Response.json(
              {
                status: diskWritable ? "ok" : "degraded",
                uptimeSeconds: process.uptime(),
                version: packageJson.version,
                // Unset unless the deploy pipeline sets it explicitly — there's
                // no CI here to inject a git SHA automatically. Documented in
                // .env.example / README for anyone who wants to wire it up
                // (e.g. `fly secrets set JARVIS_COMMIT_SHA=$(git rev-parse HEAD)`
                // before `fly deploy`) to confirm exactly which commit is live.
                commit: process.env.JARVIS_COMMIT_SHA ?? null,
                diskWritable,
              },
              { status: diskWritable ? 200 : 503 }
            );
          }

          if (!isUpgradeRequest && req.method === "GET" && url.pathname === "/status") {
            const { webAuthnService, adminToken } = this.deps;
            // Previously only gated by WebAuthn — on a deploy where Face
            // ID/Touch ID setup was never done but adminToken WAS
            // configured, this endpoint stayed wide open on the public
            // internet and leaked device lists, tool-usage, and the real
            // text of JARVIS's spoken replies (activityLog). Now also
            // accepts the same admin token /chat and the admin-gated
            // routes use, via header or query param (a plain GET can't
            // send a query param the way pollStatus() already does for
            // /chat, so both are accepted). Still open when neither
            // WebAuthn nor an admin token is configured at all (local dev).
            const hasSession = this.hasValidSession(req);
            const suppliedToken = req.headers.get("X-Jarvis-Admin-Token") ?? url.searchParams.get("token") ?? "";
            const hasValidToken = !!adminToken && constantTimeEqual(suppliedToken, adminToken);
            const authRequired = !!webAuthnService?.hasCredentials() || !!adminToken;
            if (authRequired && !hasSession && !hasValidToken) {
              return Response.json({ error: "Locked" }, { status: 401 });
            }
            return this.handleStatusJson();
          }

          if (!isUpgradeRequest && req.method === "GET" && url.pathname === "/backup") {
            return this.handleBackupHttp(req, server);
          }

          if (!isUpgradeRequest && req.method === "GET" && url.pathname === "/reminders") {
            return this.handleRemindersHttp(req, server);
          }

          if (!isUpgradeRequest && req.method === "GET" && url.pathname === "/wakeup-calls") {
            return this.handleWakeUpCallsHttp(req, server);
          }

          if (!isUpgradeRequest && req.method === "GET" && url.pathname === "/memory") {
            return this.handleMemoryHttp(req, url, server);
          }

          if (!isUpgradeRequest && req.method === "GET" && url.pathname === "/audit-log") {
            return this.handleAuditLogHttp(req, url, server);
          }

          if (!isUpgradeRequest && req.method === "GET" && url.pathname === "/providers/health") {
            return this.handleProviderHealthHttp(req, server);
          }

          if (!isUpgradeRequest && req.method === "GET" && url.pathname === "/automation-failures") {
            return this.handleAutomationFailuresHttp(req, url, server);
          }

          if (!isUpgradeRequest && req.method === "GET" && url.pathname === "/pairing/pending") {
            return this.handlePairingPendingHttp(req, server);
          }

          if (!isUpgradeRequest && req.method === "GET" && url.pathname === "/permissions") {
            return this.handlePermissionsHttp(req, server);
          }

          if (!isUpgradeRequest && req.method === "GET" && url.pathname === "/config") {
            return this.handleConfigHttp(req, server);
          }

          if (!isUpgradeRequest && req.method === "GET" && url.pathname === "/automations") {
            return this.handleAutomationsHttp(req, server);
          }

          if (!isUpgradeRequest && req.method === "GET" && url.pathname === "/cost-analytics") {
            return this.handleCostAnalyticsHttp(req, url, server);
          }

          if (!isUpgradeRequest && req.method === "GET" && url.pathname === "/agent-status") {
            return this.handleAgentStatusHttp(req, server);
          }

          if (!isUpgradeRequest && req.method === "POST" && url.pathname === "/agent/stop") {
            return await this.handleAgentStopHttp(req, server);
          }

          if (!isUpgradeRequest && req.method === "GET" && url.pathname === "/agent-recent-activity") {
            return this.handleAgentRecentActivityHttp(req, url, server);
          }

          if (!isUpgradeRequest && req.method === "GET" && url.pathname === "/command-center") {
            return new Response(null, { status: 302, headers: { Location: "/command-center/" } });
          }
          if (!isUpgradeRequest && req.method === "GET" && url.pathname === "/command-center/") {
            return new Response(Bun.file(join(COMMAND_CENTER_UI_DIR, "index.html")));
          }
          if (!isUpgradeRequest && req.method === "GET" && url.pathname.startsWith("/command-center/")) {
            return await this.serveCommandCenterAsset(url.pathname.slice("/command-center/".length));
          }

          if (!isUpgradeRequest && req.method === "GET" && url.pathname === "/admin") {
            return new Response(null, { status: 302, headers: { Location: "/admin/" } });
          }
          if (!isUpgradeRequest && req.method === "GET" && url.pathname === "/admin/") {
            return new Response(Bun.file(join(ADMIN_UI_DIR, "index.html")));
          }
          if (!isUpgradeRequest && req.method === "GET" && url.pathname.startsWith("/admin/")) {
            return await this.serveAdminAsset(url.pathname.slice("/admin/".length));
          }

          if (!isUpgradeRequest && req.method === "GET" && url.pathname === "/assets/hologram.jpg") {
            return new Response(Bun.file(HOLOGRAM_ASSET_PATH));
          }

          // The full hologram visualizer, served from Core itself — see
          // HOLOGRAM_UI_DIR above. Same lock check as "/" (a real
          // WebAuthn-gated screen makes sense here too once this is
          // reachable from the open internet, not just localhost).
          // Without the trailing slash, the browser resolves this page's
          // relative asset paths (`./three.min.js`, `./shaders/...`) against
          // `/` instead of `/hologram/` — they 404 into the catch-all
          // WebSocket-endpoint text response, wrong MIME type, and the
          // browser refuses to execute them ("THREE is not defined"),
          // silently killing the whole script before any button listener
          // ever gets attached. Redirect instead of serving the same HTML
          // at both URLs, so every relative path in the page always
          // resolves under `/hologram/`, which the route below actually serves.
          if (!isUpgradeRequest && req.method === "GET" && url.pathname === "/hologram") {
            return new Response(null, { status: 302, headers: { Location: "/hologram/" } });
          }
          if (!isUpgradeRequest && req.method === "GET" && url.pathname === "/hologram/") {
            const { webAuthnService } = this.deps;
            const locked = webAuthnService?.hasCredentials() && !this.hasValidSession(req);
            if (locked) return new Response(LOCK_HTML, { headers: { "Content-Type": "text/html" } });
            return new Response(Bun.file(join(HOLOGRAM_UI_DIR, "index.html")));
          }
          if (!isUpgradeRequest && req.method === "GET" && url.pathname.startsWith("/hologram/")) {
            return await this.serveHologramAsset(url.pathname.slice("/hologram/".length));
          }

          if (!isUpgradeRequest && url.pathname.startsWith("/auth/")) {
            return await this.handleAuthRoute(req, url, server);
          }

          if (!isUpgradeRequest && req.method === "GET" && url.pathname === "/image-proxy") {
            return await this.handleImageProxy(url);
          }

          if (!isUpgradeRequest && req.method === "GET" && url.pathname === "/calendar/oauth/start") {
            return this.handleCalendarOAuthStart(req, url, server);
          }

          if (!isUpgradeRequest && req.method === "GET" && url.pathname === "/calendar/oauth/callback") {
            return await this.handleCalendarOAuthCallback(url);
          }

          if (!isUpgradeRequest && req.method === "GET" && url.pathname === "/spotify/oauth/start") {
            return this.handleSpotifyOAuthStart(req, url, server);
          }

          if (!isUpgradeRequest && req.method === "GET" && url.pathname === "/spotify/oauth/callback") {
            return await this.handleSpotifyOAuthCallback(url);
          }

          if (!isUpgradeRequest && req.method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard")) {
            const { webAuthnService } = this.deps;
            const locked = webAuthnService?.hasCredentials() && !this.hasValidSession(req);
            return new Response(locked ? LOCK_HTML : DASHBOARD_HTML, { headers: { "Content-Type": "text/html" } });
          }

          if (isUpgradeRequest && url.pathname === "/voice/audio-stream") {
            const { audioLevelBroadcaster, twilioAuthToken, twilioPublicBaseUrl } = this.deps;
            if (!audioLevelBroadcaster) {
              return new Response("Not found", { status: 404 });
            }
            // Same signature check as every other Twilio-facing route
            // (/voice, /voice/status, /voice/gather, /sms/incoming) —
            // without it, anyone who discovers this deterministic wss://
            // URL could open it directly and feed fabricated audio into
            // the dashboard's live waveform with no real call involved.
            // Twilio signs the Media Streams connection's initial HTTP
            // handshake the same way it signs its webhook POSTs, just
            // with no form body to include in the signed payload.
            //
            // Fails CLOSED (403), not open, when twilioAuthToken/
            // twilioPublicBaseUrl aren't configured — audioLevelBroadcaster
            // only requires audioWaveformEnabled + twilioPublicBaseUrl to
            // exist (see index.ts), so a deploy with the waveform feature
            // on but no TWILIO_AUTH_TOKEN set (e.g. one rotated out, or
            // the waveform feature tried without the phone gateway) would
            // otherwise skip verification entirely and accept the socket
            // unconditionally — every sibling Twilio route (handleVoiceWebhook,
            // handleSmsWebhook) instead 404s outright without a full,
            // valid Twilio config, and this route must match that.
            if (!twilioAuthToken || !twilioPublicBaseUrl) {
              return new Response("Not found", { status: 404 });
            }
            const publicUrl = new URL(url.pathname + url.search, twilioPublicBaseUrl).toString();
            const signature = req.headers.get("X-Twilio-Signature");
            if (!verifyTwilioSignature(twilioAuthToken, publicUrl, {}, signature)) {
              console.error("[jarvis] rejected audio-stream upgrade: invalid or missing Twilio signature");
              return new Response("Forbidden", { status: 403 });
            }
            return server.upgrade(req, { data: { kind: "audio-ingest" } })
              ? undefined
              : new Response("Upgrade failed", { status: 400 });
          }

          if (isUpgradeRequest && url.pathname === "/dashboard/audio-ws") {
            const { audioLevelBroadcaster, webAuthnService } = this.deps;
            if (!audioLevelBroadcaster) {
              return new Response("Not found", { status: 404 });
            }
            // Same "locked" check GET /dashboard itself uses (a few lines
            // above) — this socket is that same locked dashboard's live
            // waveform feed (real Twilio call audio levels, gated only by
            // audioLevelBroadcaster's presence until now), so it must
            // require the same session once any WebAuthn credential is
            // registered. Without this, anyone who discovers the
            // deterministic wss://<host>/dashboard/audio-ws URL could open
            // it directly with no session at all and get a live signal of
            // exactly when phone calls are active — the one piece of
            // "dashboard" functionality that wasn't actually behind the
            // lock screen. A normal browser upgrade from the loaded
            // dashboard page already carries the session cookie, so this
            // doesn't change anything for a logged-in session.
            if (webAuthnService?.hasCredentials() && !this.hasValidSession(req)) {
              return new Response("Unauthorized", { status: 401 });
            }
            return server.upgrade(req, { data: { kind: "audio-viewer" } })
              ? undefined
              : new Response("Upgrade failed", { status: 400 });
          }

          if (isUpgradeRequest && url.pathname === "/observer") {
            // Was completely unauthenticated: any client that opened this
            // socket got a live mirror of every conversation — full
            // user/assistant text, tool inputs/results — with no admin
            // token, no session, no rate limit. On a public Fly.io deploy
            // that's a full conversational-privacy bypass. Same admin-token
            // gate as /chat now; still open for local dev with no
            // adminToken configured at all.
            const { adminToken } = this.deps;
            if (adminToken) {
              if (!this.rateLimiter.attempt(rateLimitKey(req, server, "observer"))) {
                return new Response("Too many requests", { status: 429 });
              }
              if (!constantTimeEqual(url.searchParams.get("token") ?? "", adminToken)) {
                return new Response("Unauthorized", { status: 401 });
              }
            }
            return server.upgrade(req, { data: { kind: "observer" } })
              ? undefined
              : new Response("Upgrade failed", { status: 400 });
          }

          if (isUpgradeRequest && url.pathname === "/chat") {
            if (!this.deps.webChatOrchestrator) return new Response("Not found", { status: 404 });
            // Same admin-token gate as pairing approval and WebAuthn setup
            // — required once one is configured, since a WebSocket upgrade
            // can't carry a custom header from a browser the way a normal
            // fetch() can, so the token travels as a query param instead.
            // Optional only for local dev with no adminToken set at all.
            // Rate-limited (unlike before) so the token can't be brute
            // forced via unlimited upgrade attempts — every other
            // admin-token route already goes through the rate limiter.
            const { adminToken } = this.deps;
            if (adminToken) {
              if (!this.rateLimiter.attempt(rateLimitKey(req, server, "chat"))) {
                return new Response("Too many requests", { status: 429 });
              }
              if (!constantTimeEqual(url.searchParams.get("token") ?? "", adminToken)) {
                return new Response("Unauthorized", { status: 401 });
              }
            }
            return server.upgrade(req, { data: { kind: "web-chat" } })
              ? undefined
              : new Response("Upgrade failed", { status: 400 });
          }

          if (
            server.upgrade(req, {
              data: { kind: "device", deviceId: null, ip: clientIp(req, server) },
            })
          ) {
            return undefined;
          }
          return new Response("JARVIS Core WebSocket endpoint", { status: 200 });
    } catch (error) {
      // Guarantees every HTTP response is well-formed JSON or plain text
      // (never a runtime's default error page), so an HTTP client never
      // has to guess what came back.
      const message = error instanceof Error ? error.message : "Unexpected server error";
      console.error(`[jarvis] fetch handler error: ${message}`);
      return Response.json({ success: false, error: message }, { status: 500 });
    }
  }

  /**
   * A real conversational turn from the hologram UI's chat box — parses
   * `{ text: string }`, feeds it through the exact same
   * `orchestrator.handleUserMessage()` the CLI loop and phone gateway
   * already use (so tool calls, permissions, memory — everything — work
   * identically here), and sends the real reply back as
   * `{ type: "assistant", text }`. A malformed payload or a thrown error
   * sends `{ type: "error", message }` instead of dropping the
   * connection, so the UI can show *something* went wrong rather than
   * just going silent.
   */
  private handleWebChatMessage(ws: ServerWebSocket<Extract<SocketData, { kind: "web-chat" }>>, raw: string): void {
    const { webChatOrchestrator, defaultUserId } = this.deps;
    if (!webChatOrchestrator) return; // route already 404s before upgrade if absent — defensive only

    // A CONFIRM/DANGEROUS tool call currently waiting on this exact
    // socket takes priority over starting a new conversation turn — same
    // "next message is the answer, not a new topic" UX as Telegram's own
    // awaitConfirmation(). An unparseable/non-yes/no reply re-prompts
    // rather than being silently treated as either an answer or a normal
    // chat message. Gated on `ws === pendingWebChatConfirmationSocket`
    // (not just "is a confirmation pending at all") — with more than one
    // web-chat socket connected at once (a second browser tab/window),
    // the prompt is only ever sent to the socket that was active when it
    // was requested; without this check, any OTHER still-connected
    // socket typing "yes" for something unrelated would silently resolve
    // a confirmation it never saw.
    if (this.pendingWebChatConfirmation && ws === this.pendingWebChatConfirmationSocket) {
      let candidateText = "";
      try {
        const parsed = JSON.parse(raw);
        candidateText = typeof parsed?.text === "string" ? parsed.text.trim() : "";
      } catch {
        // fall through to the re-prompt below
      }
      if (WEB_CHAT_YES_PATTERN.test(candidateText)) {
        const resolve = this.pendingWebChatConfirmation;
        this.pendingWebChatConfirmation = undefined;
        this.pendingWebChatConfirmationSocket = undefined;
        resolve(true);
        ws.send(JSON.stringify({ type: "assistant", text: "Confirmed." }));
        return;
      }
      if (WEB_CHAT_NO_PATTERN.test(candidateText)) {
        const resolve = this.pendingWebChatConfirmation;
        this.pendingWebChatConfirmation = undefined;
        this.pendingWebChatConfirmationSocket = undefined;
        resolve(false);
        ws.send(JSON.stringify({ type: "assistant", text: "Cancelled." }));
        return;
      }
      ws.send(JSON.stringify({ type: "assistant", text: "Please reply yes or no." }));
      return;
    }

    let text: string;
    let images: UserMessageImage[] | undefined;
    try {
      const parsed = JSON.parse(raw);
      const rawText = typeof parsed?.text === "string" ? parsed.text.trim() : "";
      const rawImages = Array.isArray(parsed?.images) ? parsed.images : parsed?.image ? [parsed.image] : [];

      const parsedImages: UserMessageImage[] = [];
      for (const candidate of rawImages) {
        if (!isValidWebChatImage(candidate)) {
          ws.send(JSON.stringify({ type: "error", message: "Invalid image — expected { mediaType, data } with a supported mediaType" }));
          return;
        }
        parsedImages.push({ mediaType: candidate.mediaType, data: candidate.data });
      }

      // Text-only turns still require non-empty text (unchanged
      // behavior); an image-only turn (no caption) is valid — Claude can
      // see and describe/react to an image with nothing else said.
      if (!rawText && parsedImages.length === 0) {
        ws.send(JSON.stringify({ type: "error", message: "Expected non-empty text and/or at least one image" }));
        return;
      }
      text = rawText;
      images = parsedImages.length ? parsedImages : undefined;
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    // Streaming TTS: each incremental chunk of the final reply is pushed
    // as its own `assistant_delta` frame as soon as it's generated, ahead
    // of the existing (unchanged) final `assistant` frame — a client that
    // doesn't understand `assistant_delta` simply never sees it (this
    // `ws.send` call is new, the final frame below is identical to
    // before), so this is additive, not a protocol break. Real value: a
    // long reply can start being displayed/spoken well before the whole
    // thing has been generated, instead of only ever finding out once
    // it's all done.
    webChatOrchestrator
      .handleUserMessage(defaultUserId ?? "local-user", text, images, (delta) => {
        ws.send(JSON.stringify({ type: "assistant_delta", text: delta }));
      })
      .then((response) => {
        ws.send(JSON.stringify({ type: "assistant", text: response }));
      })
      .catch((error) => {
        console.error("[jarvis] web chat turn failed:", error instanceof Error ? error.message : String(error));
        ws.send(JSON.stringify({ type: "error", message: WEB_CHAT_ERROR_MESSAGE }));
      });
  }

  /**
   * The web-chat `ConfirmationPrompter` (see `ConfirmationService`) —
   * asks a real yes/no question over the live `/chat` connection and
   * resolves once the browser answers, the same shape as
   * `TelegramGateway.awaitConfirmation()`. Resolves `false` immediately
   * if nobody is connected right now, rather than hanging until
   * ConfirmationService's own 60s timeout — there's nobody who could
   * possibly answer.
   */
  /** Whether a browser is actually connected to /chat right now — lets a shared confirmation prompter decide which channel to use. */
  get hasWebChatConnection(): boolean {
    return this.activeWebChatSocket !== undefined;
  }

  requestWebChatConfirmation(questionText: string, timeoutMs = 60_000): Promise<boolean> {
    const socket = this.activeWebChatSocket;
    if (!socket) return Promise.resolve(false);

    // Owns its own timeout rather than relying solely on
    // ConfirmationService's: that one resolves its own promise `false` on
    // timeout but has no way to reach back into `pendingWebChatConfirmation`
    // to clear it, so without this, an unanswered prompt left it set
    // forever — every future message typed into the hologram chat would
    // then be treated as a yes/no answer to the long-dead prompt and never
    // reach the Orchestrator, silently bricking the browser conversation.
    // Same fix as TelegramGateway.awaitConfirmation/DeviceVoiceGateway.awaitConfirmation.
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (this.pendingWebChatConfirmation === settle) {
          this.pendingWebChatConfirmation = undefined;
          this.pendingWebChatConfirmationSocket = undefined;
        }
        resolve(false);
      }, timeoutMs);

      const settle = (answer: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(answer);
      };

      this.pendingWebChatConfirmation = settle;
      this.pendingWebChatConfirmationSocket = socket;
      socket.send(JSON.stringify({ type: "confirm", message: questionText }));
    });
  }

  private handleMessage(ws: DeviceSocket, raw: string): void {
    const result = parseDeviceToCoreMessage(raw);

    if (!result.ok) {
      ws.send(JSON.stringify({ type: "error", reason: result.reason }));
      return;
    }

    const message = result.message;

    // Every message type below (except device.register, which is how a
    // socket establishes its identity in the first place) carries its own
    // self-declared `deviceId` straight from the client's JSON body —
    // never verified against the identity this specific socket actually
    // authenticated as during registration/pairing. Without this check, a
    // legitimately-paired device A could send device.status/
    // device.capabilities/voice.transcript/tool.result claiming to be a
    // different device B (device ids aren't secret — they're logged, shown
    // in pairing UI, echoed back in device.command acks), and Core would
    // silently act on it as if it came from B: flipping B's online status,
    // corrupting B's stored capability map, or injecting a voice command
    // under B's identity. Same "trust a device-controlled field as if it
    // were the Core-verified identity" shape as the device-role-
    // self-escalation fix.
    if (message.type !== "device.register" && ws.data.deviceId && message.deviceId && message.deviceId !== ws.data.deviceId) {
      ws.send(JSON.stringify({ type: "error", reason: "deviceId does not match the authenticated connection" }));
      return;
    }

    switch (message.type) {
      case "device.register":
        this.handleRegister(ws, message);
        return;
      case "tool.result":
        this.deps.deviceConnectionManager.handleToolResult(message as ToolResultMessage);
        return;
      case "device.status":
        if (message.deviceId) {
          this.deps.deviceRegistry.updateStatus(message.deviceId, message.payload.status);
        }
        return;
      case "pong":
        if (message.deviceId) {
          const device = this.deps.deviceRegistry.getDevice(message.deviceId);
          if (device) this.deps.deviceRegistry.updateStatus(message.deviceId, device.status);
        }
        return;
      case "event":
        // Generic device events aren't acted on in Phase 2.
        return;
      case "device.capabilities":
        if (message.deviceId) {
          try {
            this.deps.deviceRegistry.updateCapabilities(message.deviceId, message.payload.permissions);
          } catch (error) {
            console.error(`[jarvis] device.capabilities update failed for ${message.deviceId}:`, error);
          }
        }
        return;
      case "voice.transcript": {
        const { deviceVoiceGateway } = this.deps;
        if (deviceVoiceGateway && message.deviceId) {
          deviceVoiceGateway.handleTranscript(message.deviceId, message.payload.text, message.payload.wakeWord).catch((error) => {
            console.error(`[jarvis] voice.transcript handling threw for device ${message.deviceId}:`, error);
          });
        }
        return;
      }
    }
  }

  private handleRegister(ws: DeviceSocket, message: DeviceRegisterMessage): void {
    const { deviceRegistry, pairingService, deviceConnectionManager } = this.deps;
    const payload = message.payload;

    // Every registration attempt from one IP counts against the same
    // limit as pairing/login — without this, an attacker (or a buggy
    // client stuck in a reconnect loop) could open unlimited WebSocket
    // connections and spam device.register, filling DeviceRegistry with
    // junk pending-pairing entries at no cost to themselves.
    if (!this.rateLimiter.attempt(`device-register:${ws.data.ip ?? "unknown"}`)) {
      ws.send(JSON.stringify({ type: "error", reason: "Too many registration attempts, try again later" }));
      ws.close();
      return;
    }

    const deviceId = message.deviceId ?? randomUUID();
    const existingDevice = deviceRegistry.getDevice(deviceId);

    if (!existingDevice) {
      deviceRegistry.registerDevice({
        id: deviceId,
        name: payload.deviceName,
        type: payload.deviceType,
        platform: payload.platform,
        agentVersion: payload.agentVersion,
        protocolVersion: payload.protocolVersion,
        capabilities: payload.capabilities,
        requestedRole: payload.requestedRole,
      });
      this.deps.eventBus.emit("device.registered", { device: deviceRegistry.getDevice(deviceId)! });
    } else {
      // A device that's registered before still re-sends its full profile on
      // every reconnect, and it's the only place that profile comes from. Skip
      // this and an Agent upgrade never lands: Core keeps serving the version,
      // protocol version and capability list captured on the device's very
      // first connection, months out of date, while the Agent in front of it
      // has gained whole new tools.
      deviceRegistry.updateRegistrationMetadata(deviceId, {
        name: payload.deviceName,
        type: payload.deviceType,
        platform: payload.platform,
        agentVersion: payload.agentVersion,
        protocolVersion: payload.protocolVersion,
        capabilities: payload.capabilities,
        requestedRole: payload.requestedRole,
      });
    }

    const isAuthenticated = payload.credential
      ? pairingService.verifyCredential(deviceId, payload.credential)
      : false;

    if (!isAuthenticated) {
      const pairing = pairingService.requestPairing(deviceId);
      // Tracked as "known but not yet trusted" — deviceConnectionManager
      // (the authenticated set) only learns about this socket once approved.
      ws.data.deviceId = deviceId;
      this.pendingConnections.set(deviceId, ws);
      this.send(ws, deviceId, "device.command", {
        command: "pairing.pending",
        args: { code: pairing.code, expiresAt: pairing.expiresAt },
      });
      return;
    }

    this.pendingConnections.delete(deviceId);
    ws.data.deviceId = deviceId;
    const connection: DeviceConnection = { send: (data) => ws.send(data), close: () => ws.close() };
    ws.data.connection = connection;
    deviceConnectionManager.registerConnection(deviceId, connection);
    deviceRegistry.updateStatus(deviceId, "online");
    // Deliberately NOT calling maybeAssignRequestedRole() here: this
    // branch is reached purely by presenting an already-issued
    // credential, with zero human decision involved, on EVERY
    // reconnect — and updateRegistrationMetadata() above just refreshed
    // `requestedRole` from this same live, device-controlled payload. A
    // previously-paired but non-primary device could otherwise simply
    // reconnect claiming `requestedRole: "primary"` and self-grant the
    // role (and its standing tool grants — see grantPrimaryDeviceTools
    // in index.ts) with no fresh approval at all, contradicting
    // DeviceRegistry.setRole's own documented invariant that role
    // assignment is "a Core-side administrative decision, never
    // something a device can trigger on its own." approveDevice() —
    // the one human-driven pairing-approval path — remains the sole
    // place a role is ever granted. A device's role, once granted, is
    // already re-derived from persisted state at startup (see index.ts's
    // `for (const device of deviceRegistry.listDevices())` loop), so
    // nothing here needs to re-run that on a plain reconnect anyway.
    this.send(ws, deviceId, "device.command", { command: "pairing.approved" });
  }

  /**
   * Approves a device's pending pairing code, mints its long-lived
   * credential via PairingService, and — if the device's socket is still
   * open and waiting — pushes the credential to it immediately and
   * promotes the connection to authenticated. This is the only place a
   * device transitions from "registered metadata" to "trusted connection".
   *
   * A human running this (via the approve-device CLI) *is* the Core
   * decision the architecture calls for: if the device asked for a role
   * (e.g. the iMac Agent requests "primary") and nothing else already
   * holds it, approving pairing also grants it here — a device still
   * never grants itself a role by claiming one in its own payload.
   */
  approveDevice(deviceId: string, code: string): { credential: string } {
    const {
      pairingService,
      deviceConnectionManager,
      deviceRegistry,
      permissionService,
      defaultUserId,
      autoGrantToolIdsOnApproval,
      eventBus,
    } = this.deps;
    const { secret } = pairingService.approvePairing(deviceId, code);

    // Captured before maybeAssignRequestedRole: a device revoked and then
    // re-approved already holds its prior role (revokeDevice never clears
    // DeviceRegistry's role column — see its own doc comment), so
    // maybeAssignRequestedRole's "already has a role" guard skips it and
    // never re-emits "device.roleGranted". Without this, a re-approved
    // primary device's role-based standing tool grants (QUIT_APPLICATION,
    // SCHEDULE_MAC_NOTIFICATION — cleared by the earlier device.revoked)
    // stay missing until the whole process restarts, even though the
    // device still shows role: "primary" everywhere. Re-emitting here
    // re-derives them; it's a no-op for a brand-new role assignment, which
    // maybeAssignRequestedRole below already emits for on its own.
    const preExistingRole = deviceRegistry.getDevice(deviceId)?.role ?? null;

    this.maybeAssignRequestedRole(deviceId);

    if (preExistingRole) {
      eventBus.emit("device.roleGranted", { deviceId, role: preExistingRole });
    }

    if (permissionService && defaultUserId && autoGrantToolIdsOnApproval?.length) {
      for (const toolId of autoGrantToolIdsOnApproval) {
        permissionService.grant(defaultUserId, toolId, deviceId);
      }
    }

    const ws = this.pendingConnections.get(deviceId);
    if (ws) {
      this.pendingConnections.delete(deviceId);
      ws.data.deviceId = deviceId;
      const connection: DeviceConnection = { send: (data) => ws.send(data), close: () => ws.close() };
      ws.data.connection = connection;
      deviceConnectionManager.registerConnection(deviceId, connection);
      deviceRegistry.updateStatus(deviceId, "online");
      this.send(ws, deviceId, "device.command", {
        command: "pairing.approved",
        args: { credential: secret },
      });
    }

    return { credential: secret };
  }

  /**
   * Revokes a device's credential (lost/stolen/decommissioned) and
   * immediately drops its live connection if it has one — so cutting a
   * device off doesn't wait for it to naturally disconnect first. The
   * device keeps showing up in GET /status (its history isn't erased) but
   * can never reconnect without a brand-new pairing code approved again.
   *
   * Also emits "device.revoked" so index.ts can clear this device's
   * standing PermissionService grants (OPEN_APPLICATION etc.) — defense
   * in depth: those grants otherwise stay valid forever since nothing
   * else ever clears them, so a revoked device that somehow reconnected
   * (a bug elsewhere in the pairing/auth path) shouldn't silently keep
   * its old standing trust.
   */
  revokeDevice(deviceId: string): void {
    const { pairingService, deviceConnectionManager, eventBus } = this.deps;
    pairingService.revoke(deviceId);
    if (deviceConnectionManager.hasConnection(deviceId)) {
      deviceConnectionManager.removeConnection(deviceId, "revoked");
    }
    this.pendingConnections.delete(deviceId);
    eventBus.emit("device.revoked", { deviceId });
  }

  /**
   * Grants a device's originally-requested role, but only if it doesn't
   * have one yet and nothing else already holds "primary" — never
   * overrides an existing, deliberately-set role.
   */
  private maybeAssignRequestedRole(deviceId: string): void {
    const { deviceRegistry, eventBus } = this.deps;
    const device = deviceRegistry.getDevice(deviceId);
    if (!device || device.role !== null || !device.requestedRole) return;

    try {
      deviceRegistry.setRole(deviceId, device.requestedRole);
      console.log(`[jarvis] device "${device.name}" (${deviceId}) granted role: ${device.requestedRole}`);
      eventBus.emit("device.roleGranted", { deviceId, role: device.requestedRole });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown reason";
      console.log(`[jarvis] could not grant requested role to "${deviceId}": ${message}`);
    }
  }

  /**
   * Routes Twilio's Voice webhooks, after verifying `X-Twilio-Signature`
   * against the *public* URL Twilio actually signed (not this process's
   * internal view of the request, which a reverse proxy/tunnel rewrites).
   * A missing or invalid signature is always rejected — an unauthenticated
   * webhook here would let anyone drive JARVIS's tools with fabricated
   * "speech" input, no real phone call required.
   */
  private async handleVoiceWebhook(req: Request, url: URL): Promise<Response> {
    const { phoneGateway, twilioAuthToken, twilioPublicBaseUrl, twilioAllowedCallers } = this.deps;

    if (!phoneGateway || !twilioAuthToken || !twilioPublicBaseUrl) {
      return new Response("Not found", { status: 404 });
    }

    const formData = await req.formData();
    const params: Record<string, string> = {};
    for (const [key, value] of formData.entries()) {
      if (typeof value === "string") params[key] = value;
    }

    const publicUrl = new URL(url.pathname + url.search, twilioPublicBaseUrl).toString();
    const signature = req.headers.get("X-Twilio-Signature");

    if (!verifyTwilioSignature(twilioAuthToken, publicUrl, params, signature)) {
      console.error(`[jarvis] rejected voice webhook to ${url.pathname}: invalid or missing Twilio signature`);
      return new Response("Forbidden", { status: 403 });
    }

    const callSid = params.CallSid;
    if (!callSid) {
      return new Response("Bad request: missing CallSid", { status: 400 });
    }

    // Signature verification only proves the request genuinely came from
    // Twilio — it says nothing about who's on the other end of the call.
    // An allowlist, when configured, is the actual gate on that.
    if (
      url.pathname === "/voice/incoming" &&
      twilioAllowedCallers &&
      twilioAllowedCallers.length > 0 &&
      !twilioAllowedCallers.includes(params.From ?? "")
    ) {
      console.error(`[jarvis] rejected call from disallowed number: ${params.From ?? "(unknown)"}`);
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, this number isn't authorized to reach JARVIS.</Say><Hangup/></Response>`,
        { headers: { "Content-Type": "text/xml" } }
      );
    }

    switch (url.pathname) {
      case "/voice/incoming":
        return phoneGateway.handleIncomingCall(callSid);
      case "/voice/gather":
        return await phoneGateway.handleGather(callSid, params.SpeechResult ?? null);
      case "/voice/wakeup-connected":
        return await phoneGateway.handleWakeUpCallConnected(callSid);
      case "/voice/status":
        phoneGateway.handleCallEnded(callSid);
        return new Response(null, { status: 204 });
      default:
        return new Response("Not found", { status: 404 });
    }
  }

  /**
   * Routes Twilio's inbound SMS webhook, after verifying `X-Twilio-Signature`
   * exactly like /voice/* — an unauthenticated webhook here would let
   * anyone drive JARVIS's tools with a fabricated "text message," no real
   * SMS required. Shares the phone gateway's own caller allowlist
   * (twilioAllowedCallers): the same person(s) trusted to call JARVIS are
   * trusted to text it, one allowlist rather than two to keep in sync.
   */
  private async handleSmsWebhook(req: Request, url: URL): Promise<Response> {
    const { smsGateway, twilioAuthToken, twilioPublicBaseUrl, twilioAllowedCallers } = this.deps;

    if (!smsGateway || !twilioAuthToken || !twilioPublicBaseUrl) {
      return new Response("Not found", { status: 404 });
    }

    const formData = await req.formData();
    const params: Record<string, string> = {};
    for (const [key, value] of formData.entries()) {
      if (typeof value === "string") params[key] = value;
    }

    const publicUrl = new URL(url.pathname + url.search, twilioPublicBaseUrl).toString();
    const signature = req.headers.get("X-Twilio-Signature");

    if (!verifyTwilioSignature(twilioAuthToken, publicUrl, params, signature)) {
      console.error(`[jarvis] rejected SMS webhook to ${url.pathname}: invalid or missing Twilio signature`);
      return new Response("Forbidden", { status: 403 });
    }

    const fromNumber = params.From;
    if (!fromNumber) {
      return new Response("Bad request: missing From", { status: 400 });
    }

    if (twilioAllowedCallers && twilioAllowedCallers.length > 0 && !twilioAllowedCallers.includes(fromNumber)) {
      console.error(`[jarvis] rejected text from disallowed number: ${fromNumber}`);
      return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response/>`, { headers: { "Content-Type": "text/xml" } });
    }

    const mediaCount = Number.parseInt(params.NumMedia ?? "0", 10) || 0;
    return await smsGateway.handleIncomingSms(fromNumber, params.Body ?? "", mediaCount);
  }

  /**
   * Handles Telegram's Bot API webhook, after verifying the
   * `X-Telegram-Bot-Api-Secret-Token` header Telegram echoes on every
   * request (set once via setWebhook's own `secret_token` field) against
   * the configured secret. A missing or invalid secret is always
   * rejected — an unauthenticated webhook here would let anyone drive
   * JARVIS's tools with a fabricated "incoming message," no real Telegram
   * account required. Always responds 200 once the secret checks out —
   * Telegram retries a webhook that doesn't get a 2xx, and message
   * handling failures are already turned into a spoken-style error reply
   * inside TelegramGateway itself, never a thrown error here.
   */
  private async handleTelegramWebhook(req: Request, server: BunServer): Promise<Response> {
    const { telegramGateway, telegramWebhookSecret } = this.deps;
    if (!telegramGateway || !telegramWebhookSecret) {
      return new Response("Not found", { status: 404 });
    }

    // Rate-limited per client IP, same defense-in-depth as the other
    // secret-gated routes (pairing/backup/login): without this, an
    // attacker could brute-force the webhook secret with unlimited
    // attempts, only ever paying the cost of a 403.
    if (!this.rateLimiter.attempt(rateLimitKey(req, server, "telegram-webhook"))) {
      return new Response("Too many attempts, try again later", { status: 429 });
    }

    const secret = req.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
    if (!constantTimeEqual(secret, telegramWebhookSecret)) {
      console.error("[jarvis] rejected Telegram webhook: invalid or missing secret token");
      return new Response("Forbidden", { status: 403 });
    }

    let update: unknown;
    try {
      update = await req.json();
    } catch {
      return new Response("Bad request: invalid JSON", { status: 400 });
    }

    await telegramGateway.handleUpdate(update);
    return new Response(null, { status: 200 });
  }

  /**
   * Handles one Twilio Media Streams WebSocket message. Twilio's own
   * schema (https://www.twilio.com/docs/voice/media-streams/websocket-messages):
   * {event: "connected"|"start"|"media"|"stop", media?: {track, payload, ...}, ...}.
   * Only "media" events carry audio; everything else is informational and
   * safely ignored here. A malformed/unexpected message is dropped, never
   * thrown — an ingest socket misbehaving must not crash the server.
   */
  private handleAudioStreamMessage(raw: string): void {
    const { audioLevelBroadcaster } = this.deps;
    if (!audioLevelBroadcaster) return;

    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (
      typeof message !== "object" ||
      message === null ||
      (message as Record<string, unknown>).event !== "media"
    ) {
      return;
    }

    const media = (message as Record<string, unknown>).media as Record<string, unknown> | undefined;
    const payload = media?.payload;
    const track = media?.track;
    if (typeof payload !== "string" || (track !== "inbound" && track !== "outbound")) {
      return;
    }

    audioLevelBroadcaster.broadcast(computeAudioLevel(payload), track);
  }

  /**
   * GET /status — read-only JSON feed the dashboard and the hologram UI
   * (`ui/hologram/`) both poll. Gated the same way as GET / and GET
   * /dashboard: once any Face ID/Touch ID credential is registered, a
   * valid session is required here too — otherwise the dashboard lock
   * would be purely cosmetic, since this feed carries everything the
   * locked page shows (devices, activity, token/tool usage, record
   * counts) and more. `observers` (the hologram's own /observer
   * spectator count) was added on top of the dashboard's existing shape
   * rather than given a separate endpoint, so both consumers share one
   * real contract instead of two endpoints drifting apart.
   */
  private handleStatusJson(): Response {
    const {
      deviceRegistry,
      toolRegistry,
      phoneGateway,
      telegramGateway,
      activityLog,
      webAuthnService,
      audioLevelBroadcaster,
      tokenUsageStore,
      toolAuditLog,
      reminderStore,
      memoryStore,
      conversationHistoryStore,
      lockdownService,
      schedulerHealthTracker,
    } = this.deps;

    const devices = deviceRegistry.listDevices().map((device) => ({
      id: device.id,
      name: device.name,
      type: device.type,
      role: device.role,
      status: device.status,
      lastSeen: device.lastSeen,
    }));

    const tools = (toolRegistry?.listTools() ?? []).map((tool) => ({
      name: tool.name,
      target: tool.target,
    }));

    const tokenUsage = tokenUsageStore?.totals();

    return Response.json(
      {
        devices,
        tools,
        phoneGatewayEnabled: Boolean(phoneGateway),
        telegramGatewayEnabled: Boolean(telegramGateway),
        lockdown: lockdownService?.status() ?? { active: false, reason: null, activatedAt: null },
        activity: activityLog?.list() ?? [],
        webAuthnConfigured: webAuthnService?.hasCredentials() ?? true,
        audioWaveformEnabled: Boolean(audioLevelBroadcaster),
        observers: this.observers.size,
        tokenUsage: tokenUsage
          ? { ...tokenUsage, estimatedCostUsd: estimateCostUsd(tokenUsage, DEFAULT_MODEL) ?? null }
          : undefined,
        toolUsage: toolAuditLog?.summary(),
        // Last-tick timestamp/age per named background scheduler — see
        // JARVIS_ROADMAP_AUDIT.md #176. Omitted entirely when no tracker
        // is configured, same "undefined means the feature doesn't
        // exist" convention as tokenUsage/toolUsage above.
        schedulerHealth: schedulerHealthTracker?.snapshot(),
        counts: {
          memory: memoryStore?.search("").length,
          reminders: reminderStore?.list(true).length,
          pendingReminders: reminderStore?.list(false).length,
          conversationHistory: conversationHistoryStore?.count(),
        },
      },
      // CORS: the hologram UI is typically opened as a `file://` page (or
      // a different origin/port than Core), so the browser needs this
      // header to let a same-effort fetch() read the response at all —
      // without it the request still reaches the server (as curl shows)
      // but the browser silently blocks the page from seeing the body.
      // Fine to leave wide open when the dashboard isn't locked: this
      // endpoint intentionally exposes only aggregate/summary data, no
      // secrets, and is still gated by the session check above once a
      // Face ID/Touch ID credential is registered.
      { headers: { "Access-Control-Allow-Origin": "*" } }
    );
  }

  /**
   * GET /backup — downloads a gzip'd tar of every configured SQLite
   * database (memory, reminders, pairing/device credentials, transcripts,
   * etc.) for disaster recovery. Always requires the admin token: unlike
   * other admin-gated routes, there is no "optional for local dev" case
   * here — this endpoint's whole purpose is to hand out everything,
   * credentials included, so an unset admin token means 404, not "open."
   */
  private handleBackupHttp(req: Request, server: BunServer): Response {
    const { adminToken, backupDbPaths } = this.deps;

    if (!adminToken) {
      return new Response("Not found", { status: 404 });
    }

    if (!this.rateLimiter.attempt(rateLimitKey(req, server, "backup"))) {
      return Response.json({ error: "Too many attempts, try again later" }, { status: 429 });
    }

    if (!constantTimeEqual(req.headers.get("X-Jarvis-Admin-Token") ?? "", adminToken)) {
      return Response.json({ error: "Missing or invalid admin token" }, { status: 401 });
    }

    // Verify every database file actually opens and passes SQLite's own
    // PRAGMA integrity_check before handing out the archive — see
    // JARVIS_ROADMAP_AUDIT.md #164. This is deliberately best-effort,
    // not gating: a backup with one corrupted file is still far more
    // useful downloaded (the other files are fine) than refused
    // outright, but the caller needs to actually know about the bad
    // one rather than silently trusting the archive is complete.
    const integrity = verifyDatabaseIntegrity(backupDbPaths ?? []);
    const failed = integrity.filter((r) => !r.ok);
    if (failed.length > 0) {
      const logger = this.logger.withCorrelationId(randomUUID());
      for (const failure of failed) {
        const errorId = logger.error("backup_integrity_check_failed", { path: failure.path, detail: failure.detail });
        this.deps.activityLog?.record(
          `Backup integrity check FAILED for ${failure.path}: ${failure.detail} (errorId ${errorId})`
        );
      }
    }

    const response = createBackupArchive(backupDbPaths ?? []);
    response.headers.set("X-Jarvis-Backup-Integrity-Checked", String(integrity.length));
    response.headers.set("X-Jarvis-Backup-Integrity-Failed", String(failed.length));
    return response;
  }

  /**
   * GET /reminders — read-only admin view of every stored reminder
   * (including completed ones), so you can actually see what JARVIS
   * thinks it's tracking without asking it in conversation. Same admin
   * token as pairing approval — optional only for local development,
   * mandatory once this server is reachable from the public internet.
   */
  private handleRemindersHttp(req: Request, server: BunServer): Response {
    const { adminToken, reminderStore } = this.deps;
    if (!reminderStore) {
      return new Response("Not found", { status: 404 });
    }
    if (!this.rateLimiter.attempt(rateLimitKey(req, server, "reminders"))) {
      return Response.json({ error: "Too many attempts, try again later" }, { status: 429 });
    }
    if (adminToken && !constantTimeEqual(req.headers.get("X-Jarvis-Admin-Token") ?? "", adminToken)) {
      return Response.json({ error: "Missing or invalid admin token" }, { status: 401 });
    }
    return Response.json({ reminders: reminderStore.list(true) });
  }

  /**
   * GET /wakeup-calls — read-only admin view of the recurring wake-up
   * call schedule. Same admin-token gating rationale as GET /reminders.
   */
  private handleWakeUpCallsHttp(req: Request, server: BunServer): Response {
    const { adminToken, wakeUpCallStore } = this.deps;
    if (!wakeUpCallStore) {
      return new Response("Not found", { status: 404 });
    }
    if (!this.rateLimiter.attempt(rateLimitKey(req, server, "wakeup-calls"))) {
      return Response.json({ error: "Too many attempts, try again later" }, { status: 429 });
    }
    if (adminToken && !constantTimeEqual(req.headers.get("X-Jarvis-Admin-Token") ?? "", adminToken)) {
      return Response.json({ error: "Missing or invalid admin token" }, { status: 401 });
    }
    return Response.json({ wakeUpCalls: wakeUpCallStore.list() });
  }

  /**
   * GET /memory — read-only admin view of saved memory facts, and the
   * Memory Explorer's data source (JARVIS_ROADMAP_AUDIT.md #189). Optional
   * `?q=fragment` filters via `MemoryStore.search()` (matches key or
   * value); omitted or empty returns every record, same as before this
   * query param existed. Same admin-token gating rationale as GET
   * /reminders above.
   */
  private handleMemoryHttp(req: Request, url: URL, server: BunServer): Response {
    const { adminToken, memoryStore } = this.deps;
    if (!memoryStore) {
      return new Response("Not found", { status: 404 });
    }
    if (!this.rateLimiter.attempt(rateLimitKey(req, server, "memory"))) {
      return Response.json({ error: "Too many attempts, try again later" }, { status: 429 });
    }
    if (adminToken && !constantTimeEqual(req.headers.get("X-Jarvis-Admin-Token") ?? "", adminToken)) {
      return Response.json({ error: "Missing or invalid admin token" }, { status: 401 });
    }
    const query = url.searchParams.get("q") ?? "";
    return Response.json({ memory: memoryStore.search(query) });
  }

  /**
   * GET /automations — read-only admin view of every stored automation
   * rule, the Automation Explorer's data source (JARVIS_ROADMAP_AUDIT.md
   * #190). 404s when no `automationRuleStoreForAdmin` is configured. Same
   * admin-token gating rationale as GET /reminders above.
   */
  private handleAutomationsHttp(req: Request, server: BunServer): Response {
    const { adminToken, automationRuleStoreForAdmin } = this.deps;
    if (!automationRuleStoreForAdmin) {
      return new Response("Not found", { status: 404 });
    }
    if (!this.rateLimiter.attempt(rateLimitKey(req, server, "automations"))) {
      return Response.json({ error: "Too many attempts, try again later" }, { status: 429 });
    }
    if (adminToken && !constantTimeEqual(req.headers.get("X-Jarvis-Admin-Token") ?? "", adminToken)) {
      return Response.json({ error: "Missing or invalid admin token" }, { status: 401 });
    }
    return Response.json({ rules: automationRuleStoreForAdmin.list() });
  }

  /**
   * GET /cost-analytics — read-only admin view of `CostTracker` data: the
   * unified AI Cost Ledger (JARVIS_ROADMAP_AUDIT.md #192, extended in
   * batch 3). Today/week/month-to-date spend, breakdowns by
   * provider/model/task type, the most recent recorded calls, and
   * measured (not assumed) prompt-cache effectiveness — real hit rate and
   * an explicitly-labeled *estimated* dollar savings figure, never
   * presented as a real invoice line. 404s when no `costTrackerForAdmin`
   * is configured. Optional `?limit=N` for the recent-calls list (default
   * 50), and `?runId=<id>` to instead return that one run's full ledger
   * rollup (every dimension in one place) in place of the aggregate
   * breakdowns — 404s with a body if that runId has no recorded calls.
   * `toolCache` (hit/miss/hitRate for `ToolResultCache`) is included only
   * when `toolResultCacheForAdmin` is configured. Same admin-token gating
   * rationale as GET /reminders above.
   */
  private handleCostAnalyticsHttp(req: Request, url: URL, server: BunServer): Response {
    const { adminToken, costTrackerForAdmin, toolResultCacheForAdmin } = this.deps;
    if (!costTrackerForAdmin) {
      return new Response("Not found", { status: 404 });
    }
    if (!this.rateLimiter.attempt(rateLimitKey(req, server, "cost-analytics"))) {
      return Response.json({ error: "Too many attempts, try again later" }, { status: 429 });
    }
    if (adminToken && !constantTimeEqual(req.headers.get("X-Jarvis-Admin-Token") ?? "", adminToken)) {
      return Response.json({ error: "Missing or invalid admin token" }, { status: 401 });
    }

    const runId = url.searchParams.get("runId");
    if (runId) {
      const ledger = costTrackerForAdmin.getRunLedger(runId);
      if (!ledger) {
        return Response.json({ error: `No recorded calls for runId "${runId}"` }, { status: 404 });
      }
      return Response.json({ runLedger: ledger });
    }

    const limitParam = url.searchParams.get("limit");
    const limit = limitParam ? Number(limitParam) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
      return Response.json({ error: "limit must be a positive integer" }, { status: 400 });
    }
    return Response.json({
      todaySpendUsd: costTrackerForAdmin.getTodaySpend(),
      weekSpendUsd: costTrackerForAdmin.getWeekSpend(),
      monthSpendUsd: costTrackerForAdmin.getMonthSpend(),
      byProvider: costTrackerForAdmin.getBreakdownByProvider(),
      byModel: costTrackerForAdmin.getBreakdownByModel(),
      byTaskType: costTrackerForAdmin.getBreakdownByTaskType(),
      recent: costTrackerForAdmin.listRecent(limit ?? 50),
      // Real, measured prompt-cache effectiveness — see CostTracker.getCacheStats's
      // own doc comment for why estimatedSavingsUsd specifically (and only
      // that field) is an estimate, not a measured number.
      promptCache: costTrackerForAdmin.getCacheStats(),
      toolCache: toolResultCacheForAdmin?.getStats(),
    });
  }

  /**
   * GET /agent-status — read-only admin view of every live session's
   * current `JarvisLiveState` snapshot (state, language, stopRequested,
   * updatedAt) — the Live Agent Monitor / "what are you doing right now?"
   * status (JARVIS_ROADMAP_AUDIT.md #187/#195). 404s when no
   * `liveStateTracker` is configured. Same admin-token gating rationale
   * as GET /reminders above.
   */
  private handleAgentStatusHttp(req: Request, server: BunServer): Response {
    const { adminToken, liveStateTracker } = this.deps;
    if (!liveStateTracker) {
      return new Response("Not found", { status: 404 });
    }
    if (!this.rateLimiter.attempt(rateLimitKey(req, server, "agent-status"))) {
      return Response.json({ error: "Too many attempts, try again later" }, { status: 429 });
    }
    if (adminToken && !constantTimeEqual(req.headers.get("X-Jarvis-Admin-Token") ?? "", adminToken)) {
      return Response.json({ error: "Missing or invalid admin token" }, { status: 401 });
    }
    return Response.json({ sessions: liveStateTracker.listSessions() });
  }

  /**
   * POST /agent/stop — the Stop button's backend (JARVIS_ROADMAP_AUDIT.md
   * #196), a thin HTTP wrapper over `Orchestrator.requestStop(userId)`
   * (already real and tested — `tests/core/JarvisLiveState.test.ts`,
   * `tests/integration/liveState.integration.test.ts`). Body:
   * `{ "userId": "..." }`. Only ever targets the primary web-chat
   * Orchestrator (`webChatOrchestrator`) — the one stable, always-present
   * Orchestrator instance this server holds a reference to; the phone/SMS/
   * Telegram/device-voice Orchestrators are created per-call/session
   * inside src/index.ts closures this server has no handle on, so
   * stopping those isn't reachable from here yet. 404s when no
   * `webChatOrchestrator` is configured. Same admin-token gating rationale
   * as GET /reminders above (this is a control action, not read-only, so
   * the admin token matters even more here).
   */
  private async handleAgentStopHttp(req: Request, server: BunServer): Promise<Response> {
    const { adminToken, webChatOrchestrator } = this.deps;
    if (!webChatOrchestrator) {
      return new Response("Not found", { status: 404 });
    }
    if (!this.rateLimiter.attempt(rateLimitKey(req, server, "agent-stop"))) {
      return Response.json({ error: "Too many attempts, try again later" }, { status: 429 });
    }
    if (adminToken && !constantTimeEqual(req.headers.get("X-Jarvis-Admin-Token") ?? "", adminToken)) {
      return Response.json({ error: "Missing or invalid admin token" }, { status: 401 });
    }
    let body: { userId?: unknown };
    try {
      body = (await req.json()) as { userId?: unknown };
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    if (typeof body.userId !== "string" || body.userId.length === 0) {
      return Response.json({ error: "userId is required" }, { status: 400 });
    }
    const stopped = webChatOrchestrator.requestStop(body.userId);
    return Response.json({ stopped });
  }

  /**
   * GET /agent-recent-activity?sessionId=...&limit=... — read-only admin
   * view of one live session's recent JarvisLiveState transition history
   * (ToolAuditLog.listRecentTransitions), most recent first. Answers "what
   * was JARVIS doing a few minutes ago", complementing GET /agent-status's
   * "what is it doing right now". Required `sessionId` (the same opaque
   * key `GET /agent-status` rows carry as `sessionId`). 404s when no
   * `toolAuditLog` is configured. Same admin-token gating rationale as
   * GET /agent-status.
   */
  private handleAgentRecentActivityHttp(req: Request, url: URL, server: BunServer): Response {
    const { adminToken, toolAuditLog } = this.deps;
    if (!toolAuditLog) {
      return new Response("Not found", { status: 404 });
    }
    if (!this.rateLimiter.attempt(rateLimitKey(req, server, "agent-recent-activity"))) {
      return Response.json({ error: "Too many attempts, try again later" }, { status: 429 });
    }
    if (adminToken && !constantTimeEqual(req.headers.get("X-Jarvis-Admin-Token") ?? "", adminToken)) {
      return Response.json({ error: "Missing or invalid admin token" }, { status: 401 });
    }
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      return Response.json({ error: "sessionId is required" }, { status: 400 });
    }
    const limitParam = url.searchParams.get("limit");
    let limit: number | undefined;
    if (limitParam !== null) {
      limit = Number(limitParam);
      if (!Number.isInteger(limit) || limit <= 0) {
        return Response.json({ error: "limit must be a positive integer" }, { status: 400 });
      }
    }
    const transitions = toolAuditLog.listRecentTransitions(sessionId, limit);
    // Performance metrics (Phase 45): computed on the fly from these same
    // already-persisted transitions — no separate tracking, see
    // `computeTurnLatencies`'s own doc comment. Most recent turn first,
    // matching `transitions`' own ordering.
    return Response.json({ transitions, turnLatencies: computeTurnLatencies(transitions) });
  }

  /**
   * GET /audit-log — read-only admin view of the full structured tool
   * execution trail (ToolAuditLog), distinct from the summary stats
   * already exposed via /status. Same admin-token gating rationale as
   * GET /reminders/etc. Optional `?tool=TOOL_ID` and `?limit=N` query
   * params, mirroring ToolAuditLog.list()'s own options.
   */
  private handleAuditLogHttp(req: Request, url: URL, server: BunServer): Response {
    const { adminToken, toolAuditLog } = this.deps;
    if (!toolAuditLog) {
      return new Response("Not found", { status: 404 });
    }
    if (!this.rateLimiter.attempt(rateLimitKey(req, server, "audit-log"))) {
      return Response.json({ error: "Too many attempts, try again later" }, { status: 429 });
    }
    if (adminToken && !constantTimeEqual(req.headers.get("X-Jarvis-Admin-Token") ?? "", adminToken)) {
      return Response.json({ error: "Missing or invalid admin token" }, { status: 401 });
    }
    const toolName = url.searchParams.get("tool") ?? undefined;
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam ? Number(limitParam) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
      return Response.json({ error: "limit must be a positive integer" }, { status: 400 });
    }
    return Response.json({ entries: toolAuditLog.list({ toolName, limit }) });
  }

  /**
   * GET /providers/health — read-only admin view of `AIRouter.getProviderStatus()`
   * (circuit-breaker state, consecutive failures, latency, success rate
   * per configured AI provider) — see JARVIS_ROADMAP_AUDIT.md #174. Same
   * admin-token gating rationale as GET /reminders above; 404s when no
   * AIRouter is configured.
   */
  private handleProviderHealthHttp(req: Request, server: BunServer): Response {
    const { adminToken, aiRouter } = this.deps;
    if (!aiRouter) {
      return new Response("Not found", { status: 404 });
    }
    if (!this.rateLimiter.attempt(rateLimitKey(req, server, "providers-health"))) {
      return Response.json({ error: "Too many attempts, try again later" }, { status: 429 });
    }
    if (adminToken && !constantTimeEqual(req.headers.get("X-Jarvis-Admin-Token") ?? "", adminToken)) {
      return Response.json({ error: "Missing or invalid admin token" }, { status: 401 });
    }
    return Response.json({ providers: aiRouter.getProviderStatus() });
  }

  /**
   * GET /automation-failures — read-only admin view of every proactive
   * automation rule execution that threw, a durable record distinct
   * from the transient ActivityLog entry a failure also produces — see
   * JARVIS_ROADMAP_AUDIT.md #177/#178. Same admin-token gating rationale
   * as GET /reminders above; 404s when no AutomationFailureStore is
   * configured. Optional `?limit=N` query param.
   */
  private handleAutomationFailuresHttp(req: Request, url: URL, server: BunServer): Response {
    const { adminToken, automationFailureStore } = this.deps;
    if (!automationFailureStore) {
      return new Response("Not found", { status: 404 });
    }
    if (!this.rateLimiter.attempt(rateLimitKey(req, server, "automation-failures"))) {
      return Response.json({ error: "Too many attempts, try again later" }, { status: 429 });
    }
    if (adminToken && !constantTimeEqual(req.headers.get("X-Jarvis-Admin-Token") ?? "", adminToken)) {
      return Response.json({ error: "Missing or invalid admin token" }, { status: 401 });
    }
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam ? Number(limitParam) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
      return Response.json({ error: "limit must be a positive integer" }, { status: 400 });
    }
    return Response.json({ failures: automationFailureStore.list(limit) });
  }

  /**
   * GET /pairing/pending — read-only admin view of every currently
   * pending device-pairing request (deviceId, its 6-digit code,
   * expiry), for the Device Approval Web UI (JARVIS_ROADMAP_AUDIT.md
   * #200) to render an approve/deny button against, without needing to
   * already know a device's code from watching agent logs the way the
   * CLI flow requires. Same admin-token gating rationale as GET
   * /reminders above. This is purely additive: `bun run approve-device`
   * keeps working exactly as before, this only adds a second way to see
   * what's pending.
   */
  private handlePairingPendingHttp(req: Request, server: BunServer): Response {
    const { adminToken, pairingService } = this.deps;
    if (!this.rateLimiter.attempt(rateLimitKey(req, server, "pairing-pending"))) {
      return Response.json({ error: "Too many attempts, try again later" }, { status: 429 });
    }
    if (adminToken && !constantTimeEqual(req.headers.get("X-Jarvis-Admin-Token") ?? "", adminToken)) {
      return Response.json({ error: "Missing or invalid admin token" }, { status: 401 });
    }
    return Response.json({ pending: pairingService.listPending() });
  }

  /**
   * GET /permissions — read-only admin view of every standing
   * `(userId, toolId, deviceId)` grant held by `PermissionService` — see
   * JARVIS_ROADMAP_AUDIT.md #205 (Permission Management UI). Read-only by
   * design: granting/revoking individual permissions from a UI is a
   * bigger surface for mistakes than this first pass is worth: revocation
   * already has a real, safe path (`POST /pairing/revoke`, which clears a
   * device's grants alongside its credential). 404s when no
   * `permissionServiceForAdmin` is configured.
   */
  private handlePermissionsHttp(req: Request, server: BunServer): Response {
    const { adminToken, permissionServiceForAdmin } = this.deps;
    if (!permissionServiceForAdmin) {
      return new Response("Not found", { status: 404 });
    }
    if (!this.rateLimiter.attempt(rateLimitKey(req, server, "permissions"))) {
      return Response.json({ error: "Too many attempts, try again later" }, { status: 429 });
    }
    if (adminToken && !constantTimeEqual(req.headers.get("X-Jarvis-Admin-Token") ?? "", adminToken)) {
      return Response.json({ error: "Missing or invalid admin token" }, { status: 401 });
    }
    return Response.json({ grants: permissionServiceForAdmin.list() });
  }

  /**
   * GET /config — read-only admin view of the loaded `JarvisConfig`, for
   * the Config Center (JARVIS_ROADMAP_AUDIT.md #208). Every secret-shaped
   * field (API keys, the admin token itself, webhook secrets, OAuth
   * client secrets) is replaced by `redactConfigForDisplay` with just
   * whether it's set — never the real value, the same care GET /status
   * and GET /health already take not to leak one. 404s when no
   * `jarvisConfig` is configured.
   */
  private handleConfigHttp(req: Request, server: BunServer): Response {
    const { adminToken, jarvisConfig } = this.deps;
    if (!jarvisConfig) {
      return new Response("Not found", { status: 404 });
    }
    if (!this.rateLimiter.attempt(rateLimitKey(req, server, "config"))) {
      return Response.json({ error: "Too many attempts, try again later" }, { status: 429 });
    }
    if (adminToken && !constantTimeEqual(req.headers.get("X-Jarvis-Admin-Token") ?? "", adminToken)) {
      return Response.json({ error: "Missing or invalid admin token" }, { status: 401 });
    }
    return Response.json({ config: redactConfigForDisplay(jarvisConfig) });
  }

  /**
   * GET /image-proxy?url=<pollinations image URL> — fetches a JARVIS-
   * generated image server-side and re-serves it with
   * `Content-Disposition: attachment`, so the media panel's download
   * button (ui/hologram/index.html) actually forces a save-to-device
   * instead of just opening the image in a new tab. A browser only
   * honors an `<a download>` attribute for a same-origin URL —
   * image.pollinations.ai is cross-origin, so the direct link alone
   * couldn't force a real download (a known limitation called out when
   * that panel first shipped). Routing the bytes through Core's own
   * origin fixes that.
   *
   * Deliberately restricted to exactly the one trusted host
   * (image.pollinations.ai) GenerateImageTool actually generates
   * images from — never a general-purpose proxy for an arbitrary URL,
   * which would otherwise let this endpoint be used to probe internal
   * network addresses (SSRF) or hotlink arbitrary third-party content
   * through Core's own IP.
   */
  private async handleImageProxy(url: URL): Promise<Response> {
    const target = url.searchParams.get("url");
    if (!target) {
      return Response.json({ error: "Missing url parameter" }, { status: 400 });
    }

    let parsedTarget: URL;
    try {
      parsedTarget = new URL(target);
    } catch {
      return Response.json({ error: "Invalid url parameter" }, { status: 400 });
    }
    if (parsedTarget.protocol !== "https:" || parsedTarget.hostname !== "image.pollinations.ai") {
      return Response.json({ error: "url must be an https://image.pollinations.ai URL" }, { status: 400 });
    }

    let upstream: Response;
    try {
      upstream = await fetch(parsedTarget.toString());
    } catch (error) {
      return Response.json(
        { error: `Failed to fetch image: ${error instanceof Error ? error.message : String(error)}` },
        { status: 502 }
      );
    }
    if (!upstream.ok) {
      return Response.json({ error: `Upstream returned ${upstream.status}` }, { status: 502 });
    }

    return new Response(upstream.body, {
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") ?? "image/jpeg",
        "Content-Disposition": "attachment; filename=\"jarvis-image.jpg\"",
      },
    });
  }

  /**
   * GET /calendar/oauth/start — begins linking a Google account for
   * read-only Calendar access. Gated by the admin token as a query
   * parameter (`?token=...`), not a header: this is a route the user
   * navigates to directly in a browser to reach Google's consent screen,
   * which a fetch header can't do. Rate-limited per client IP, same
   * defense-in-depth as the other admin-token-gated routes — a token
   * passed in a URL is otherwise guessable at no cost beyond a 401.
   */
  private handleCalendarOAuthStart(req: Request, url: URL, server: BunServer): Response {
    const { adminToken, calendarClient } = this.deps;
    if (!calendarClient || !adminToken) {
      return new Response("Not found", { status: 404 });
    }
    if (!this.rateLimiter.attempt(rateLimitKey(req, server, "calendar-oauth-start"))) {
      return Response.json({ error: "Too many attempts, try again later" }, { status: 429 });
    }
    if (!constantTimeEqual(url.searchParams.get("token") ?? "", adminToken)) {
      return Response.json({ error: "Missing or invalid admin token" }, { status: 401 });
    }

    this.purgeExpiredOAuthStates();
    const state = randomUUID();
    this.pendingOAuthStates.set(state, Date.now());
    return Response.redirect(calendarClient.buildAuthUrl(state), 302);
  }

  /** Drops any issued-but-never-redeemed OAuth state past its TTL, so an abandoned/repeated /start never accumulates entries forever. */
  private purgeExpiredOAuthStates(): void {
    const cutoff = Date.now() - OAUTH_STATE_TTL_MS;
    for (const [state, issuedAt] of this.pendingOAuthStates) {
      if (issuedAt < cutoff) this.pendingOAuthStates.delete(state);
    }
  }

  /** GET /calendar/oauth/callback — Google redirects here once the user grants (or denies) access. */
  private async handleCalendarOAuthCallback(url: URL): Promise<Response> {
    const { calendarClient } = this.deps;
    if (!calendarClient) {
      return new Response("Not found", { status: 404 });
    }

    const error = url.searchParams.get("error");
    if (error) {
      return new Response(`Google Calendar linking was not completed: ${error}`, { status: 400 });
    }

    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const issuedAt = state ? this.pendingOAuthStates.get(state) : undefined;
    if (!state || issuedAt === undefined || issuedAt < Date.now() - OAUTH_STATE_TTL_MS || !code) {
      return new Response("Invalid or expired OAuth state", { status: 400 });
    }
    this.pendingOAuthStates.delete(state);

    let linkedEmail: string;
    try {
      // Additive: exchangeCodeForTokens identifies the Google account via
      // its own userinfo endpoint and upserts only THAT account's row —
      // re-running this flow and picking a different account at Google's
      // consent screen links a second/third account without touching
      // whichever was linked before; picking the SAME account again just
      // refreshes its tokens in place.
      linkedEmail = await calendarClient.exchangeCodeForTokens(code);
    } catch (err) {
      console.error("[jarvis] Google Calendar OAuth exchange failed:", err instanceof Error ? err.message : String(err));
      return new Response("Failed to complete Google Calendar linking. Check the server logs for details.", {
        status: 500,
      });
    }

    return new Response(
      `Google account ${linkedEmail} linked successfully. To link another account, visit ` +
        "/calendar/oauth/start again and choose a different account at Google's consent screen. You can close this tab.",
      { headers: { "Content-Type": "text/plain" } }
    );
  }

  /**
   * GET /spotify/oauth/start — begins linking a Spotify account for
   * playback control. Same admin-token-in-query-param gating and
   * rate-limiting rationale as GET /calendar/oauth/start.
   */
  private handleSpotifyOAuthStart(req: Request, url: URL, server: BunServer): Response {
    const { adminToken, spotifyClient } = this.deps;
    if (!spotifyClient || !adminToken) {
      return new Response("Not found", { status: 404 });
    }
    if (!this.rateLimiter.attempt(rateLimitKey(req, server, "spotify-oauth-start"))) {
      return Response.json({ error: "Too many attempts, try again later" }, { status: 429 });
    }
    if (!constantTimeEqual(url.searchParams.get("token") ?? "", adminToken)) {
      return Response.json({ error: "Missing or invalid admin token" }, { status: 401 });
    }

    this.purgeExpiredSpotifyOAuthStates();
    const state = randomUUID();
    this.pendingSpotifyOAuthStates.set(state, Date.now());
    return Response.redirect(spotifyClient.buildAuthUrl(state), 302);
  }

  /** Same purpose as `purgeExpiredOAuthStates`, for the separate Spotify state map. */
  private purgeExpiredSpotifyOAuthStates(): void {
    const cutoff = Date.now() - OAUTH_STATE_TTL_MS;
    for (const [state, issuedAt] of this.pendingSpotifyOAuthStates) {
      if (issuedAt < cutoff) this.pendingSpotifyOAuthStates.delete(state);
    }
  }

  /** GET /spotify/oauth/callback — Spotify redirects here once the user grants (or denies) access. */
  private async handleSpotifyOAuthCallback(url: URL): Promise<Response> {
    const { spotifyClient } = this.deps;
    if (!spotifyClient) {
      return new Response("Not found", { status: 404 });
    }

    const error = url.searchParams.get("error");
    if (error) {
      return new Response(`Spotify linking was not completed: ${error}`, { status: 400 });
    }

    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const issuedAt = state ? this.pendingSpotifyOAuthStates.get(state) : undefined;
    if (!state || issuedAt === undefined || issuedAt < Date.now() - OAUTH_STATE_TTL_MS || !code) {
      return new Response("Invalid or expired OAuth state", { status: 400 });
    }
    this.pendingSpotifyOAuthStates.delete(state);

    try {
      await spotifyClient.exchangeCodeForTokens(code);
    } catch (err) {
      console.error("[jarvis] Spotify OAuth exchange failed:", err instanceof Error ? err.message : String(err));
      return new Response("Failed to complete Spotify linking. Check the server logs for details.", {
        status: 500,
      });
    }

    return new Response("Spotify linked successfully. You can close this tab.", {
      headers: { "Content-Type": "text/plain" },
    });
  }

  private hasValidSession(req: Request): boolean {
    const { sessionStore } = this.deps;
    if (!sessionStore) return false;
    return sessionStore.isValid(readCookie(req, SESSION_COOKIE));
  }

  /**
   * Serves one static file from ui/hologram/ by its path under /hologram/
   * (three.min.js, postprocessing/*, shaders/*, facetrack/*, the sprite/
   * texture assets, etc.) — everything the visualizer's own <script src>
   * tags and fetch()es need once it's loaded from here instead of a local
   * file:// open. `relPath` is attacker-controlled (the request URL), so
   * this rejects any `..` segment before joining it onto HOLOGRAM_UI_DIR,
   * and double-checks the resolved path still lands inside that directory
   * — defense in depth against a path-traversal request ever reading a
   * file outside ui/hologram/.
   */
  private async serveHologramAsset(relPath: string): Promise<Response> {
    if (relPath.includes("..")) return new Response("Not found", { status: 404 });
    const filePath = join(HOLOGRAM_UI_DIR, relPath);
    if (!filePath.startsWith(HOLOGRAM_UI_DIR)) return new Response("Not found", { status: 404 });
    const file = Bun.file(filePath);
    if (!(await file.exists())) return new Response("Not found", { status: 404 });
    return new Response(file);
  }

  /** Same path-traversal defense as serveHologramAsset, for ui/admin/ instead. */
  private async serveAdminAsset(relPath: string): Promise<Response> {
    if (relPath.includes("..")) return new Response("Not found", { status: 404 });
    const filePath = join(ADMIN_UI_DIR, relPath);
    if (!filePath.startsWith(ADMIN_UI_DIR)) return new Response("Not found", { status: 404 });
    const file = Bun.file(filePath);
    if (!(await file.exists())) return new Response("Not found", { status: 404 });
    return new Response(file);
  }

  /** Same path-traversal defense as serveAdminAsset, for ui/command-center/ instead. */
  private async serveCommandCenterAsset(relPath: string): Promise<Response> {
    if (relPath.includes("..")) return new Response("Not found", { status: 404 });
    const filePath = join(COMMAND_CENTER_UI_DIR, relPath);
    if (!filePath.startsWith(COMMAND_CENTER_UI_DIR)) return new Response("Not found", { status: 404 });
    const file = Bun.file(filePath);
    if (!(await file.exists())) return new Response("Not found", { status: 404 });
    return new Response(file);
  }

  /**
   * Face ID / Touch ID (WebAuthn) ceremony endpoints. Registration
   * requires the same admin token as device-pairing approval — otherwise
   * whoever loads the dashboard first could register their own face as
   * "the owner." Login requires no secret: the platform authenticator
   * ceremony itself is the proof.
   */
  private async handleAuthRoute(req: Request, url: URL, server: BunServer): Promise<Response> {
    const { webAuthnService, sessionStore, adminToken } = this.deps;
    if (!webAuthnService || !sessionStore) {
      return new Response("Not found", { status: 404 });
    }
    const { origin, rpID } = getOriginAndRpID(req, url);

    if (url.pathname === "/auth/login" && !this.rateLimiter.attempt(rateLimitKey(req, server, "auth-login"))) {
      return Response.json({ error: "Too many attempts, try again later" }, { status: 429 });
    }

    if (url.pathname === "/auth/register-options" || url.pathname === "/auth/register") {
      if (!this.rateLimiter.attempt(rateLimitKey(req, server, "auth-register"))) {
        return Response.json({ error: "Too many attempts, try again later" }, { status: 429 });
      }
    }

    if (req.method === "POST" && url.pathname === "/auth/register-options") {
      if (!adminToken || !constantTimeEqual(req.headers.get("X-Jarvis-Admin-Token") ?? "", adminToken)) {
        return Response.json({ error: "Missing or invalid admin token" }, { status: 401 });
      }
      const options = await webAuthnService.createRegistrationOptions(rpID);
      return Response.json(options);
    }

    if (req.method === "POST" && url.pathname === "/auth/register") {
      if (!adminToken || !constantTimeEqual(req.headers.get("X-Jarvis-Admin-Token") ?? "", adminToken)) {
        return Response.json({ error: "Missing or invalid admin token" }, { status: 401 });
      }
      const body = (await req.json().catch(() => null)) as { response?: unknown } | null;
      if (!body?.response) return Response.json({ error: "Missing response" }, { status: 400 });
      const verified = await webAuthnService.verifyRegistration(body.response as never, rpID, origin);
      if (!verified) return Response.json({ error: "Verification failed" }, { status: 400 });
      return Response.json({ success: true });
    }

    if (req.method === "GET" && url.pathname === "/auth/login-options") {
      const options = await webAuthnService.createAuthenticationOptions(rpID);
      return Response.json(options);
    }

    if (req.method === "POST" && url.pathname === "/auth/login") {
      const body = (await req.json().catch(() => null)) as { response?: unknown } | null;
      if (!body?.response) return Response.json({ error: "Missing response" }, { status: 400 });
      const verified = await webAuthnService.verifyAuthentication(body.response as never, rpID, origin);
      if (!verified) return Response.json({ error: "Verification failed" }, { status: 401 });

      const token = sessionStore.create();
      const secure = origin.startsWith("https://") ? "; Secure" : "";
      return Response.json(
        { success: true },
        { headers: { "Set-Cookie": `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/${secure}` } }
      );
    }

    if (req.method === "POST" && url.pathname === "/auth/logout") {
      sessionStore.revoke(readCookie(req, SESSION_COOKIE));
      const secure = origin.startsWith("https://") ? "; Secure" : "";
      return Response.json(
        { success: true },
        { headers: { "Set-Cookie": `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}` } }
      );
    }

    return new Response("Not found", { status: 404 });
  }

  private async handleApproveHttp(req: Request, server: BunServer): Promise<Response> {
    if (!this.rateLimiter.attempt(rateLimitKey(req, server, "pairing-approve"))) {
      return Response.json({ success: false, error: "Too many attempts, try again later" }, { status: 429 });
    }

    const { adminToken } = this.deps;
    if (adminToken && !constantTimeEqual(req.headers.get("X-Jarvis-Admin-Token") ?? "", adminToken)) {
      return Response.json({ success: false, error: "Missing or invalid admin token" }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
    }

    if (
      typeof body !== "object" ||
      body === null ||
      typeof (body as Record<string, unknown>).deviceId !== "string" ||
      typeof (body as Record<string, unknown>).code !== "string"
    ) {
      return Response.json({ success: false, error: "Body must be { deviceId: string, code: string }" }, { status: 400 });
    }

    const { deviceId, code } = body as { deviceId: string; code: string };

    try {
      const result = this.approveDevice(deviceId, code);
      return Response.json({ success: true, deviceId, credentialIssued: Boolean(result.credential) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to approve pairing";
      return Response.json({ success: false, error: message }, { status: 400 });
    }
  }

  /**
   * Lets a human cut off a lost/stolen device remotely (e.g. from a phone
   * browser, via curl) without needing shell access to wherever Core
   * actually runs — the only other way to revoke trust today. Same
   * admin-token gate and rate limit as /pairing/approve, since both let
   * someone reshape which devices JARVIS trusts.
   */
  private async handleRevokeHttp(req: Request, server: BunServer): Promise<Response> {
    if (!this.rateLimiter.attempt(rateLimitKey(req, server, "pairing-revoke"))) {
      return Response.json({ success: false, error: "Too many attempts, try again later" }, { status: 429 });
    }

    const { adminToken } = this.deps;
    if (adminToken && !constantTimeEqual(req.headers.get("X-Jarvis-Admin-Token") ?? "", adminToken)) {
      return Response.json({ success: false, error: "Missing or invalid admin token" }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
    }

    if (typeof body !== "object" || body === null || typeof (body as Record<string, unknown>).deviceId !== "string") {
      return Response.json({ success: false, error: "Body must be { deviceId: string }" }, { status: 400 });
    }

    const { deviceId } = body as { deviceId: string };
    this.revokeDevice(deviceId);
    return Response.json({ success: true, deviceId });
  }

  /**
   * The break-glass kill switch. Same admin-token gate and rate limit as
   * /pairing/approve /pairing/revoke — anyone who can flip this can stop
   * JARVIS from acting at all, which is exactly the point in an emergency
   * (a stolen phone, a device behaving unexpectedly) but must never be
   * reachable without the admin token.
   */
  private async handleLockdownHttp(req: Request, server: BunServer, action: "activate" | "lift"): Promise<Response> {
    if (!this.rateLimiter.attempt(rateLimitKey(req, server, "emergency-lockdown"))) {
      return Response.json({ success: false, error: "Too many attempts, try again later" }, { status: 429 });
    }

    const { adminToken, lockdownService } = this.deps;
    if (!lockdownService) {
      return new Response("Not found", { status: 404 });
    }

    if (adminToken && !constantTimeEqual(req.headers.get("X-Jarvis-Admin-Token") ?? "", adminToken)) {
      return Response.json({ success: false, error: "Missing or invalid admin token" }, { status: 401 });
    }

    if (action === "lift") {
      lockdownService.deactivate();
      console.log("[jarvis] emergency lockdown lifted");
      return Response.json({ success: true, status: lockdownService.status() });
    }

    let reason: string | undefined;
    try {
      const body = (await req.json()) as { reason?: string } | null;
      reason = typeof body?.reason === "string" ? body.reason : undefined;
    } catch {
      // A bare POST with no body is fine — reason is optional.
    }

    lockdownService.activate(reason);
    console.error(`[jarvis] EMERGENCY LOCKDOWN ACTIVATED${reason ? `: ${reason}` : ""}`);
    return Response.json({ success: true, status: lockdownService.status() });
  }

  /**
   * Pings every device still waiting on a human to approve its pairing
   * code — `deviceConnectionManager.pingAll()` only reaches *authenticated*
   * connections, so without this, a pending socket got no keepalive at
   * all and Bun's own `idleTimeout` (120s) silently closed it the moment
   * approving took a human longer than that — observed live: the Agent's
   * pairing code kept changing out from under a real approval attempt,
   * with "Socket is not connected" in between. Same mechanism as
   * `pingAll()`: the real "pong" reply is itself socket activity, which
   * is what actually resets the idle timer.
   */
  private pingPendingConnections(): void {
    for (const [deviceId, ws] of this.pendingConnections) {
      ws.send(JSON.stringify(makeEnvelope("ping", {}, deviceId, randomUUID())));
    }
  }

  private send(
    ws: DeviceSocket,
    deviceId: string,
    type: "device.command",
    payload: { command: string; args?: Record<string, unknown> }
  ): void {
    ws.send(JSON.stringify(makeEnvelope(type, payload, deviceId, randomUUID())));
  }
}

/**
 * A real write+delete test against the data directory, not just a stat
 * check — a full disk can leave a directory perfectly "existing" and
 * listable while every actual write to it fails with ENOSPC. Returns true
 * when no directory is configured (e.g. :memory: setups in tests/local
 * dev), since there's nothing to check and this must never be the reason
 * a health check without persistence reports unhealthy.
 */
function isDataDirectoryWritable(dataDirectory: string | undefined): boolean {
  if (!dataDirectory) return true;
  const probePath = join(dataDirectory, ".jarvis-health-check");
  try {
    writeFileSync(probePath, "");
    unlinkSync(probePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * True only when this process is actually running as a Fly.io Machine —
 * Fly injects FLY_APP_NAME (among others) into every Machine's
 * environment automatically, and nothing else does. Deliberately NOT just
 * "is the Fly-Client-IP header present": that header is only trustworthy
 * because Fly's own proxy always overwrites any client-supplied value of
 * it before forwarding — a guarantee that holds only when Fly's proxy is
 * actually the sole entry point. This same Dockerfile is documented to
 * also run on Railway, Render, or a plain VPS (see README "Cloud
 * deployment"); on any of those, nothing strips a client-supplied
 * Fly-Client-IP header, so blindly trusting its presence would let any
 * caller set an arbitrary value on every request and get a fresh
 * rate-limit bucket each time — a straightforward brute-force bypass on
 * pairing/auth/device-registration. Read fresh each call, not cached at
 * module load, purely so tests can toggle it per case.
 */
function isRunningOnFly(): boolean {
  return Boolean(process.env.FLY_APP_NAME);
}

/**
 * The real caller's IP, not the address the app's socket actually sees.
 * Fly.io's edge proxy terminates the client connection and forwards to
 * this app over its own internal network — `server.requestIP()` returns
 * *that* internal hop, which is the same for every request when deployed,
 * collapsing per-IP rate limiting into one shared bucket for every caller.
 * `Fly-Client-IP` is only trusted when `isRunningOnFly()` is true (see
 * above) — everywhere else, including local dev/tests and any non-Fly
 * deployment of this same Dockerfile, this falls straight through to the
 * raw socket address exactly as before.
 */
function clientIp(req: Request, server: BunServer): string | null {
  const flyClientIp = isRunningOnFly() ? req.headers.get("Fly-Client-IP") : null;
  return flyClientIp ?? server.requestIP(req)?.address ?? null;
}

/**
 * Keys the rate limiter by (route, client IP) — falling back to a single
 * shared bucket for that route when the IP can't be determined (e.g. in a
 * test harness with no real socket) rather than throwing, since a fallback
 * that's slightly too strict is a far safer failure mode here than one
 * that silently disables the limit entirely.
 */
function rateLimitKey(req: Request, server: BunServer, route: string): string {
  return `${route}:${clientIp(req, server) ?? "unknown"}`;
}

/**
 * Applied to every HTTP response this server sends. `nosniff` stops a
 * browser from re-guessing a response's content type against its own
 * heuristics (relevant since some routes serve user-influenced device
 * names as plain text); `DENY` stops the dashboard from being framed by
 * another site (clickjacking); `no-referrer` keeps this server's own URLs
 * (including the pairing/admin routes) out of any Referer header sent to
 * a third party a dashboard link might be clicked through to.
 */
function withSecurityHeaders(response: Response): Response {
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

const VALID_WEB_CHAT_IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

// Same recognized words as TelegramGateway's own YES_PATTERN/NO_PATTERN —
// kept deliberately identical rather than diverging per channel.
const WEB_CHAT_YES_PATTERN = /^\s*(yes|y|כן|אישור|confirm)\s*$/i;
const WEB_CHAT_NO_PATTERN = /^\s*(no|n|לא|ביטול|cancel)\s*$/i;

// Same friendly, generic wording every other channel already uses
// (TelegramGateway, TwilioSmsGateway, TwilioVoiceGateway's own
// ERROR_MESSAGE constants) — found live: this was the one channel still
// sending the raw thrown error straight to the user, e.g. a full upstream
// provider error body ("OpenRouter chat completion failed (429): {...raw
// JSON...}") once every configured AI provider was exhausted. The real
// error is still logged server-side for debugging; nothing useful about
// an upstream 429's JSON body belongs in a user-facing chat bubble.
const WEB_CHAT_ERROR_MESSAGE = "Sorry, something went wrong on my end. Please try again.";

/**
 * Structural validation only (right mediaType, non-empty base64 string) —
 * size/count limits are Orchestrator.handleUserMessage's job
 * (MAX_IMAGE_BASE64_LENGTH/MAX_IMAGES_PER_MESSAGE), so they stay in one
 * place rather than duplicated at every channel that can attach an image.
 */
function isValidWebChatImage(candidate: unknown): candidate is UserMessageImage {
  if (typeof candidate !== "object" || candidate === null) return false;
  const { mediaType, data } = candidate as Record<string, unknown>;
  return (
    typeof mediaType === "string" &&
    VALID_WEB_CHAT_IMAGE_MEDIA_TYPES.has(mediaType) &&
    typeof data === "string" &&
    data.length > 0
  );
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
