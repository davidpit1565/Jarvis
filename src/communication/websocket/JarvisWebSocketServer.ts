import type { ServerWebSocket } from "bun";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { EventBus } from "@/core/events/EventBus";
import type { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import type { PairingService } from "@/devices/pairing/PairingService";
import type { ToolRegistry } from "@/tools/registry/ToolRegistry";
import type { ActivityLog } from "@/core/activity/ActivityLog";
import { DeviceConnectionManager } from "./DeviceConnectionManager";
import type { TwilioVoiceGateway } from "@/communication/phone/TwilioVoiceGateway";
import { verifyTwilioSignature } from "@/communication/phone/twilioSignature";
import { DASHBOARD_HTML, LOCK_HTML } from "./dashboard";
import type { WebAuthnService } from "@/auth/WebAuthnService";
import type { SessionStore } from "@/auth/SessionStore";
import { AudioLevelBroadcaster } from "./AudioLevelBroadcaster";
import { computeAudioLevel } from "@/communication/phone/audioLevel";
import {
  makeEnvelope,
  parseDeviceToCoreMessage,
  type DeviceRegisterMessage,
  type ToolResultMessage,
} from "./protocol";

type SocketData =
  | { kind: "device"; deviceId: string | null }
  | { kind: "audio-ingest" }
  | { kind: "audio-viewer" };

type DeviceSocket = ServerWebSocket<Extract<SocketData, { kind: "device" }>>;

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

  constructor(private readonly deps: JarvisWebSocketServerDependencies) {}

  start(port: number) {
    return Bun.serve<SocketData>({
      port,
      fetch: async (req, server) => {
        try {
          const url = new URL(req.url);

          if (req.method === "POST" && url.pathname === "/pairing/approve") {
            return await this.handleApproveHttp(req);
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
            return Response.json({ status: "ok", uptimeSeconds: process.uptime() });
          }

          if (!isUpgradeRequest && req.method === "GET" && url.pathname === "/status") {
            return this.handleStatusJson();
          }

          if (!isUpgradeRequest && req.method === "GET" && url.pathname === "/assets/hologram.jpg") {
            return new Response(Bun.file(HOLOGRAM_ASSET_PATH));
          }

          if (!isUpgradeRequest && url.pathname.startsWith("/auth/")) {
            return await this.handleAuthRoute(req, url);
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

          if (server.upgrade(req, { data: { kind: "device", deviceId: null } })) {
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
    deviceConnectionManager.registerConnection(deviceId, { send: (data) => ws.send(data) });
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
      deviceConnectionManager.registerConnection(deviceId, { send: (data) => ws.send(data) });
      deviceRegistry.updateStatus(deviceId, "online");
      this.send(ws, deviceId, "device.command", {
        command: "pairing.approved",
        args: { credential: secret },
      });
    }

    return { credential: secret };
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

  /** GET /status — read-only JSON feed the dashboard polls; no auth today, matching the rest of Core. */
  private handleStatusJson(): Response {
    const { deviceRegistry, toolRegistry, phoneGateway, activityLog, webAuthnService, audioLevelBroadcaster } =
      this.deps;

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

    return Response.json({
      devices,
      tools,
      phoneGatewayEnabled: Boolean(phoneGateway),
      activity: activityLog?.list() ?? [],
      webAuthnConfigured: webAuthnService?.hasCredentials() ?? true,
      audioWaveformEnabled: Boolean(audioLevelBroadcaster),
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
  private async handleAuthRoute(req: Request, url: URL): Promise<Response> {
    const { webAuthnService, sessionStore, adminToken } = this.deps;
    if (!webAuthnService || !sessionStore) {
      return new Response("Not found", { status: 404 });
    }
    const { origin, rpID } = getOriginAndRpID(req, url);

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

  private async handleApproveHttp(req: Request): Promise<Response> {
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

  private send(
    ws: DeviceSocket,
    deviceId: string,
    type: "device.command",
    payload: { command: string; args?: Record<string, unknown> }
  ): void {
    ws.send(JSON.stringify(makeEnvelope(type, payload, deviceId, randomUUID())));
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
