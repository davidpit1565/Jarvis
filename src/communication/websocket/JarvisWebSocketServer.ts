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
import type { WakeUpCallStore } from "@/wakeup/WakeUpCallStore";
import { DeviceConnectionManager } from "./DeviceConnectionManager";
import type { TwilioVoiceGateway } from "@/communication/phone/TwilioVoiceGateway";
import type { TelegramGateway } from "@/communication/telegram/TelegramGateway";
import type { LockdownService } from "@/core/lockdown/LockdownService";
import { verifyTwilioSignature } from "@/communication/phone/twilioSignature";
import { DASHBOARD_HTML, LOCK_HTML } from "./dashboard";
import type { WebAuthnService } from "@/auth/WebAuthnService";
import type { SessionStore } from "@/auth/SessionStore";
import { AudioLevelBroadcaster } from "./AudioLevelBroadcaster";
import { RateLimiter } from "./RateLimiter";
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
  | { kind: "audio-viewer" };

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
   * Optional break-glass kill switch. When set, enables POST
   * /emergency/lockdown and POST /emergency/lockdown/lift (both admin-token
   * gated) and includes lockdown status in GET /status. Without it, both
   * routes 404 and the feature doesn't exist for this instance.
   */
  lockdownService?: LockdownService;
}

const SESSION_COOKIE = "jarvis_session";
const HOLOGRAM_ASSET_PATH = join(import.meta.dir, "assets", "hologram.jpg");
// Generous for a real, one-time, deliberate action (nobody takes 10
// minutes to click through Google's consent screen), short enough that
// an abandoned/repeated /calendar/oauth/start never leaves state entries
// accumulating for long.
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

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

  /**
   * Read-only spectators connected on `/observer` (e.g. the hologram UI in
   * `ui/hologram/`) — never part of the device protocol, never trusted with
   * device.register/tool.result, just mirrored every EventBus event so a
   * human can watch what Core is actually doing in real time.
   */
  private observers: Set<ServerWebSocket<SocketData>> = new Set();

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
    const pingInterval = setInterval(() => this.deps.deviceConnectionManager.pingAll(), 45_000);
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
            const { webAuthnService } = this.deps;
            if (webAuthnService?.hasCredentials() && !this.hasValidSession(req)) {
              return Response.json({ error: "Locked" }, { status: 401 });
            }
            return this.handleStatusJson();
          }

          if (!isUpgradeRequest && req.method === "GET" && url.pathname === "/backup") {
            return this.handleBackupHttp(req, server);
          }

          if (!isUpgradeRequest && req.method === "GET" && url.pathname === "/reminders") {
            return this.handleRemindersHttp(req);
          }

          if (!isUpgradeRequest && req.method === "GET" && url.pathname === "/wakeup-calls") {
            return this.handleWakeUpCallsHttp(req);
          }

          if (!isUpgradeRequest && req.method === "GET" && url.pathname === "/memory") {
            return this.handleMemoryHttp(req);
          }

          if (!isUpgradeRequest && req.method === "GET" && url.pathname === "/audit-log") {
            return this.handleAuditLogHttp(req, url);
          }

          if (!isUpgradeRequest && req.method === "GET" && url.pathname === "/assets/hologram.jpg") {
            return new Response(Bun.file(HOLOGRAM_ASSET_PATH));
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
            return server.upgrade(req, { data: { kind: "observer" } })
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
    const { pairingService, deviceConnectionManager, deviceRegistry } = this.deps;
    const { secret } = pairingService.approvePairing(deviceId, code);

    this.maybeAssignRequestedRole(deviceId);

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

    return createBackupArchive(backupDbPaths ?? []);
  }

  /**
   * GET /reminders — read-only admin view of every stored reminder
   * (including completed ones), so you can actually see what JARVIS
   * thinks it's tracking without asking it in conversation. Same admin
   * token as pairing approval — optional only for local development,
   * mandatory once this server is reachable from the public internet.
   */
  private handleRemindersHttp(req: Request): Response {
    const { adminToken, reminderStore } = this.deps;
    if (!reminderStore) {
      return new Response("Not found", { status: 404 });
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
  private handleWakeUpCallsHttp(req: Request): Response {
    const { adminToken, wakeUpCallStore } = this.deps;
    if (!wakeUpCallStore) {
      return new Response("Not found", { status: 404 });
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
  private handleMemoryHttp(req: Request): Response {
    const { adminToken, memoryStore } = this.deps;
    if (!memoryStore) {
      return new Response("Not found", { status: 404 });
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
  private handleAuditLogHttp(req: Request, url: URL): Response {
    const { adminToken, toolAuditLog } = this.deps;
    if (!toolAuditLog) {
      return new Response("Not found", { status: 404 });
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

  private hasValidSession(req: Request): boolean {
    const { sessionStore } = this.deps;
    if (!sessionStore) return false;
    return sessionStore.isValid(readCookie(req, SESSION_COOKIE));
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

function constantTimeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
