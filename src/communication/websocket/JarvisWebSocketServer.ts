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
import { DeviceConnectionManager } from "./DeviceConnectionManager";
import type { TwilioVoiceGateway } from "@/communication/phone/TwilioVoiceGateway";
import type { TwilioSmsGateway } from "@/communication/phone/TwilioSmsGateway";
import type { TelegramGateway } from "@/communication/telegram/TelegramGateway";
import type { DeviceVoiceGateway } from "@/communication/voice/DeviceVoiceGateway";
import type { LockdownService } from "@/core/lockdown/LockdownService";
import { verifyTwilioSignature } from "@/communication/phone/twilioSignature";
import { DASHBOARD_HTML, LOCK_HTML } from "./dashboard";
import type { WebAuthnService } from "@/auth/WebAuthnService";
import type { SessionStore } from "@/auth/SessionStore";
import { AudioLevelBroadcaster } from "./AudioLevelBroadcaster";
import { RateLimiter } from "./RateLimiter";
import type { AIRouter } from "@/core/brain/AIRouter";
import type { SchedulerHealthTracker } from "@/core/health/SchedulerHealthTracker";
import type { AutomationFailureStore } from "@/automation/AutomationFailureStore";
import { verifyDatabaseIntegrity } from "@/backup/verifyBackupIntegrity";
import { Logger } from "@/core/logging/Logger";
import { computeAudioLevel } from "@/communication/phone/audioLevel";
import {
  makeEnvelope,
  parseDeviceToCoreMessage,
  type DeviceRegisterMessage,
  type ToolResultMessage,
} from "./protocol";

type SocketData =
  | { kind: "device"; deviceId: string | null; ip: string | null }
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
              this.deps.deviceConnectionManager.handleDisconnect(deviceId, "socket_closed");
              this.deps.deviceRegistry.updateStatus(deviceId, "offline");
            }
          } else if (socket.data.kind === "audio-viewer") {
            this.deps.audioLevelBroadcaster?.removeViewer(socket);
          } else if (socket.data.kind === "web-chat") {
            if (this.activeWebChatSocket === socket) {
              this.activeWebChatSocket = undefined;
              // Nobody left to answer — deny rather than leave it
              // hanging until ConfirmationService's own timeout.
              this.pendingWebChatConfirmation?.(false);
              this.pendingWebChatConfirmation = undefined;
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
            return this.handleMemoryHttp(req, server);
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
            if (!this.deps.audioLevelBroadcaster) {
              return new Response("Not found", { status: 404 });
            }
            return server.upgrade(req, { data: { kind: "audio-ingest" } })
              ? undefined
              : new Response("Upgrade failed", { status: 400 });
          }

          if (isUpgradeRequest && url.pathname === "/dashboard/audio-ws") {
            if (!this.deps.audioLevelBroadcaster) {
              return new Response("Not found", { status: 404 });
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
    // chat message.
    if (this.pendingWebChatConfirmation) {
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
        resolve(true);
        ws.send(JSON.stringify({ type: "assistant", text: "Confirmed." }));
        return;
      }
      if (WEB_CHAT_NO_PATTERN.test(candidateText)) {
        const resolve = this.pendingWebChatConfirmation;
        this.pendingWebChatConfirmation = undefined;
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

    webChatOrchestrator
      .handleUserMessage(defaultUserId ?? "local-user", text, images)
      .then((response) => {
        ws.send(JSON.stringify({ type: "assistant", text: response }));
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : "Unexpected error";
        ws.send(JSON.stringify({ type: "error", message }));
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

  requestWebChatConfirmation(questionText: string): Promise<boolean> {
    const socket = this.activeWebChatSocket;
    if (!socket) return Promise.resolve(false);

    return new Promise<boolean>((resolve) => {
      this.pendingWebChatConfirmation = resolve;
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
    deviceConnectionManager.registerConnection(deviceId, { send: (data) => ws.send(data), close: () => ws.close() });
    deviceRegistry.updateStatus(deviceId, "online");
    this.maybeAssignRequestedRole(deviceId);
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
    const { pairingService, deviceConnectionManager, deviceRegistry, permissionService, defaultUserId, autoGrantToolIdsOnApproval } =
      this.deps;
    const { secret } = pairingService.approvePairing(deviceId, code);

    this.maybeAssignRequestedRole(deviceId);

    if (permissionService && defaultUserId && autoGrantToolIdsOnApproval?.length) {
      for (const toolId of autoGrantToolIdsOnApproval) {
        permissionService.grant(defaultUserId, toolId, deviceId);
      }
    }

    const ws = this.pendingConnections.get(deviceId);
    if (ws) {
      this.pendingConnections.delete(deviceId);
      ws.data.deviceId = deviceId;
      deviceConnectionManager.registerConnection(deviceId, { send: (data) => ws.send(data), close: () => ws.close() });
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

    return await smsGateway.handleIncomingSms(fromNumber, params.Body ?? "");
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

    const secret = req.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (secret !== telegramWebhookSecret) {
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
   * GET /memory — read-only admin view of every saved memory fact. Same
   * admin-token gating rationale as GET /reminders above.
   */
  private handleMemoryHttp(req: Request, server: BunServer): Response {
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
    return Response.json({ memory: memoryStore.search("") });
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

    try {
      await calendarClient.exchangeCodeForTokens(code);
    } catch (err) {
      console.error("[jarvis] Google Calendar OAuth exchange failed:", err instanceof Error ? err.message : String(err));
      return new Response("Failed to complete Google Calendar linking. Check the server logs for details.", {
        status: 500,
      });
    }

    return new Response("Google Calendar linked successfully. You can close this tab.", {
      headers: { "Content-Type": "text/plain" },
    });
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
