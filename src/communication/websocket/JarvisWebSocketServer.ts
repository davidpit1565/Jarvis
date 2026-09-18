import type { Server, ServerWebSocket } from "bun";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
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
import { DeviceConnectionManager } from "./DeviceConnectionManager";
import type { TwilioVoiceGateway } from "@/communication/phone/TwilioVoiceGateway";
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
  | { kind: "audio-ingest" }
  | { kind: "audio-viewer" };

type DeviceSocket = ServerWebSocket<Extract<SocketData, { kind: "device" }>>;
type BunServer = Server<SocketData>;

export interface JarvisWebSocketServerDependencies {
  deviceRegistry: DeviceRegistry;
  deviceConnectionManager: DeviceConnectionManager;
  pairingService: PairingService;
  eventBus: EventBus;
  /** Optional: enables tool names/targets in the GET /status dashboard feed. */
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
}

const SESSION_COOKIE = "jarvis_session";
const HOLOGRAM_ASSET_PATH = join(import.meta.dir, "assets", "hologram.jpg");

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

  constructor(private readonly deps: JarvisWebSocketServerDependencies) {}

  start(port: number) {
    return Bun.serve<SocketData>({
      port,
      fetch: async (req, server) => {
        const response = await this.route(req, server);
        // A WebSocket upgrade returns undefined by design (Bun owns the
        // response in that case) — only an actual HTTP response gets the
        // headers below.
        return response ? withSecurityHeaders(response) : undefined;
      },
      websocket: {
        open: (ws) => {
          const socket = ws as ServerWebSocket<SocketData>;
          if (socket.data.kind === "audio-viewer") {
            this.deps.audioLevelBroadcaster?.addViewer(socket);
          }
          // Device sockets: a no-op here — only meaningful once they register.
        },
        message: (ws, raw) => {
          const socket = ws as ServerWebSocket<SocketData>;
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

          if (req.method === "POST" && url.pathname.startsWith("/voice/")) {
            return await this.handleVoiceWebhook(req, url);
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
            return Response.json({
              status: "ok",
              uptimeSeconds: process.uptime(),
              version: packageJson.version,
              // Unset unless the deploy pipeline sets it explicitly — there's
              // no CI here to inject a git SHA automatically. Documented in
              // .env.example / README for anyone who wants to wire it up
              // (e.g. `fly secrets set JARVIS_COMMIT_SHA=$(git rev-parse HEAD)`
              // before `fly deploy`) to confirm exactly which commit is live.
              commit: process.env.JARVIS_COMMIT_SHA ?? null,
            });
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

          if (!isUpgradeRequest && req.method === "GET" && url.pathname === "/memory") {
            return this.handleMemoryHttp(req);
          }

          if (!isUpgradeRequest && req.method === "GET" && url.pathname === "/assets/hologram.jpg") {
            return new Response(Bun.file(HOLOGRAM_ASSET_PATH));
          }

          if (!isUpgradeRequest && url.pathname.startsWith("/auth/")) {
            return await this.handleAuthRoute(req, url, server);
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

          if (
            server.upgrade(req, {
              data: { kind: "device", deviceId: null, ip: server.requestIP(req)?.address ?? null },
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
      case "event":
        // Heartbeats and generic device events aren't acted on in Phase 2.
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
   */
  revokeDevice(deviceId: string): void {
    const { pairingService, deviceConnectionManager } = this.deps;
    pairingService.revoke(deviceId);
    if (deviceConnectionManager.hasConnection(deviceId)) {
      deviceConnectionManager.removeConnection(deviceId, "revoked");
    }
    this.pendingConnections.delete(deviceId);
  }

  /**
   * Grants a device's originally-requested role, but only if it doesn't
   * have one yet and nothing else already holds "primary" — never
   * overrides an existing, deliberately-set role.
   */
  private maybeAssignRequestedRole(deviceId: string): void {
    const { deviceRegistry } = this.deps;
    const device = deviceRegistry.getDevice(deviceId);
    if (!device || device.role !== null || !device.requestedRole) return;

    try {
      deviceRegistry.setRole(deviceId, device.requestedRole);
      console.log(`[jarvis] device "${device.name}" (${deviceId}) granted role: ${device.requestedRole}`);
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
      case "/voice/status":
        phoneGateway.handleCallEnded(callSid);
        return new Response(null, { status: 204 });
      default:
        return new Response("Not found", { status: 404 });
    }
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
   * GET /status — read-only JSON feed the dashboard polls. Gated the same
   * way as GET / and GET /dashboard: once any Face ID/Touch ID credential
   * is registered, a valid session is required here too — otherwise the
   * dashboard lock would be purely cosmetic, since this feed carries
   * everything the locked page shows (devices, activity, token/tool usage,
   * record counts) and more.
   */
  private handleStatusJson(): Response {
    const {
      deviceRegistry,
      toolRegistry,
      phoneGateway,
      activityLog,
      webAuthnService,
      audioLevelBroadcaster,
      tokenUsageStore,
      toolAuditLog,
      reminderStore,
      memoryStore,
      conversationHistoryStore,
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

    return Response.json({
      devices,
      tools,
      phoneGatewayEnabled: Boolean(phoneGateway),
      activity: activityLog?.list() ?? [],
      webAuthnConfigured: webAuthnService?.hasCredentials() ?? true,
      audioWaveformEnabled: Boolean(audioLevelBroadcaster),
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
    });
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
 * Keys the rate limiter by (route, client IP) — falling back to a single
 * shared bucket for that route when the IP can't be determined (e.g. in a
 * test harness with no real socket) rather than throwing, since a fallback
 * that's slightly too strict is a far safer failure mode here than one
 * that silently disables the limit entirely.
 */
function rateLimitKey(req: Request, server: BunServer, route: string): string {
  const ip = server.requestIP(req)?.address ?? "unknown";
  return `${route}:${ip}`;
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
