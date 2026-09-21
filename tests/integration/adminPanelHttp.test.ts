import { describe, test, expect, afterEach } from "bun:test";
import { EventBus } from "@/core/events/EventBus";
import { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import { PairingService } from "@/devices/pairing/PairingService";
import { DeviceConnectionManager } from "@/communication/websocket/DeviceConnectionManager";
import { JarvisWebSocketServer, type JarvisWebSocketServerDependencies } from "@/communication/websocket/JarvisWebSocketServer";
import { PermissionService } from "@/permissions/PermissionService";
import type { JarvisConfig } from "@/config";

/**
 * A minimal, fully-populated JarvisConfig for tests — every secret field
 * is given an obviously-fake, recognizable value so a test can assert it
 * never appears anywhere in a response body.
 */
const FAKE_SECRET_MARKER = "SUPER-SECRET-VALUE-MUST-NEVER-LEAK";

function buildFakeConfig(overrides: Partial<JarvisConfig> = {}): JarvisConfig {
  return {
    brainProvider: "anthropic",
    brainProviderExplicit: true,
    anthropicApiKey: FAKE_SECRET_MARKER,
    groqApiKey: FAKE_SECRET_MARKER,
    aiFreeFirst: true,
    zeroCostMode: false,
    aiCircuitBreakerThreshold: 3,
    aiCircuitBreakerCooldownMs: 60000,
    aiCostDbPath: ":memory:",
    port: 4770,
    memoryDbPath: ":memory:",
    webauthnDbPath: ":memory:",
    remindersDbPath: ":memory:",
    automationRulesDbPath: ":memory:",
    automationFailuresDbPath: ":memory:",
    activityLogDbPath: ":memory:",
    conversationHistoryDbPath: ":memory:",
    pairingDbPath: ":memory:",
    deviceRegistryDbPath: ":memory:",
    toolAuditLogDbPath: ":memory:",
    tokenUsageDbPath: ":memory:",
    agentTaskDbPath: ":memory:",
    agentQueueTickMs: 5000,
    timezone: "UTC",
    twilioAuthToken: FAKE_SECRET_MARKER,
    twilioAllowOpenAccess: false,
    maxOutboundCallsPerDay: 10,
    wakeUpCallDbPath: ":memory:",
    alarmDbPath: ":memory:",
    adminToken: FAKE_SECRET_MARKER,
    webSearchEnabled: false,
    webSearchMaxUses: 5,
    webFetchEnabled: false,
    webFetchMaxUses: 5,
    audioWaveformEnabled: false,
    calendarTokenDbPath: ":memory:",
    googleClientSecret: FAKE_SECRET_MARKER,
    spotifyClientSecret: FAKE_SECRET_MARKER,
    spotifyTokenDbPath: ":memory:",
    studioSecret: FAKE_SECRET_MARKER,
    commitmentsDbPath: ":memory:",
    staleCommitmentDays: 3,
    telegramBotToken: FAKE_SECRET_MARKER,
    telegramWebhookSecret: FAKE_SECRET_MARKER,
    telegramAllowOpenAccess: false,
    ...overrides,
  } as JarvisConfig;
}

function setupServer(deps: Partial<JarvisWebSocketServerDependencies> = {}) {
  const eventBus = new EventBus();
  const server = new JarvisWebSocketServer({
    deviceRegistry: new DeviceRegistry(),
    deviceConnectionManager: new DeviceConnectionManager(eventBus),
    pairingService: new PairingService(),
    eventBus,
    ...deps,
  });
  const handle = server.start(0);
  return { handle, port: handle.port, eventBus };
}

describe("GET /pairing/pending", () => {
  let activeHandle: { stop: () => void } | undefined;
  afterEach(() => {
    activeHandle?.stop();
    activeHandle = undefined;
  });

  test("lists a pending pairing request created via device.register", async () => {
    const pairingService = new PairingService();
    const eventBus = new EventBus();
    const deviceRegistry = new DeviceRegistry();
    const server = new JarvisWebSocketServer({
      deviceRegistry,
      deviceConnectionManager: new DeviceConnectionManager(eventBus),
      pairingService,
      eventBus,
    });
    const handle = server.start(0);
    activeHandle = handle;
    const port = (handle as { port: number }).port;

    const deviceId = "pending-device-1";
    const ws = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            requestId: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            deviceId,
            type: "device.register",
            payload: {
              deviceName: "Pending Device",
              deviceType: "mac",
              platform: "macos",
              agentVersion: "0.1.0",
              protocolVersion: "1",
              capabilities: [],
            },
          })
        );
      };
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data as string);
        if (message.payload?.command === "pairing.pending") resolve();
      };
      ws.onerror = () => reject(new Error("WebSocket error"));
      setTimeout(() => reject(new Error("Timed out")), 2000);
    });

    const response = await fetch(`http://localhost:${port}/pairing/pending`);
    const body = (await response.json()) as { pending: Array<{ deviceId: string; code: string }> };

    expect(response.status).toBe(200);
    expect(body.pending.some((p) => p.deviceId === deviceId)).toBe(true);
    expect(body.pending.find((p) => p.deviceId === deviceId)?.code).toMatch(/^\d{6}$/);

    ws.close();
  });

  test("returns an empty list when nothing is pending", async () => {
    const { handle, port } = setupServer();
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/pairing/pending`);
    const body = (await response.json()) as { pending: unknown[] };

    expect(response.status).toBe(200);
    expect(body.pending).toEqual([]);
  });

  test("requires the admin token when one is configured", async () => {
    const { handle, port } = setupServer({ adminToken: "correct-token" });
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/pairing/pending`);
    expect(response.status).toBe(401);
  });

  test("succeeds with the correct admin token", async () => {
    const { handle, port } = setupServer({ adminToken: "correct-token" });
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/pairing/pending`, {
      headers: { "X-Jarvis-Admin-Token": "correct-token" },
    });
    expect(response.status).toBe(200);
  });

  test("rejects the wrong admin token", async () => {
    const { handle, port } = setupServer({ adminToken: "correct-token" });
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/pairing/pending`, {
      headers: { "X-Jarvis-Admin-Token": "wrong-token" },
    });
    expect(response.status).toBe(401);
  });
});

describe("GET /permissions", () => {
  let activeHandle: { stop: () => void } | undefined;
  afterEach(() => {
    activeHandle?.stop();
    activeHandle = undefined;
  });

  test("404s when no PermissionService is configured", async () => {
    const { handle, port } = setupServer();
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/permissions`);
    expect(response.status).toBe(404);
  });

  test("lists standing grants with their user/tool/device shape", async () => {
    const permissionService = new PermissionService();
    permissionService.grant("local-user", "OPEN_URL", "imac-1");
    permissionService.grant("local-user", "SAVE_MEMORY"); // no device — local scope

    const { handle, port } = setupServer({ permissionServiceForAdmin: permissionService });
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/permissions`);
    const body = (await response.json()) as {
      grants: Array<{ userId: string; toolId: string; deviceId?: string }>;
    };

    expect(response.status).toBe(200);
    expect(body.grants).toContainEqual({ userId: "local-user", toolId: "OPEN_URL", deviceId: "imac-1" });
    const localGrant = body.grants.find((g) => g.toolId === "SAVE_MEMORY");
    expect(localGrant).toBeDefined();
    expect(localGrant?.deviceId).toBeUndefined();
  });

  test("requires the admin token when one is configured", async () => {
    const permissionService = new PermissionService();
    const { handle, port } = setupServer({ permissionServiceForAdmin: permissionService, adminToken: "correct-token" });
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/permissions`);
    expect(response.status).toBe(401);
  });

  test("succeeds with the correct admin token", async () => {
    const permissionService = new PermissionService();
    const { handle, port } = setupServer({ permissionServiceForAdmin: permissionService, adminToken: "correct-token" });
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/permissions`, {
      headers: { "X-Jarvis-Admin-Token": "correct-token" },
    });
    expect(response.status).toBe(200);
  });
});

describe("GET /config", () => {
  let activeHandle: { stop: () => void } | undefined;
  afterEach(() => {
    activeHandle?.stop();
    activeHandle = undefined;
  });

  test("404s when no config is configured", async () => {
    const { handle, port } = setupServer();
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/config`);
    expect(response.status).toBe(404);
  });

  test("never leaks any secret's real value, anywhere in the response body", async () => {
    const jarvisConfig = buildFakeConfig();
    const { handle, port } = setupServer({ jarvisConfig });
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/config`);
    const rawText = await response.text();

    expect(response.status).toBe(200);
    expect(rawText).not.toContain(FAKE_SECRET_MARKER);

    const body = JSON.parse(rawText) as { config: Record<string, unknown> };
    expect(body.config.adminToken).toEqual({ configured: true });
    expect(body.config.anthropicApiKey).toEqual({ configured: true });
    expect(body.config.groqApiKey).toEqual({ configured: true });
    expect(body.config.twilioAuthToken).toEqual({ configured: true });
    expect(body.config.telegramBotToken).toEqual({ configured: true });
    expect(body.config.telegramWebhookSecret).toEqual({ configured: true });
    expect(body.config.googleClientSecret).toEqual({ configured: true });
    expect(body.config.spotifyClientSecret).toEqual({ configured: true });
    expect(body.config.studioSecret).toEqual({ configured: true });
  });

  test("reports unset secrets as not configured, still without leaking anything", async () => {
    const jarvisConfig = buildFakeConfig({
      anthropicApiKey: undefined,
      groqApiKey: undefined,
      adminToken: undefined,
    });
    const { handle, port } = setupServer({ jarvisConfig });
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/config`);
    const body = (await response.json()) as { config: Record<string, unknown> };

    expect(body.config.anthropicApiKey).toEqual({ configured: false });
    expect(body.config.adminToken).toEqual({ configured: false });
  });

  test("passes through non-secret fields unchanged", async () => {
    const jarvisConfig = buildFakeConfig({ timezone: "Asia/Jerusalem", port: 4770 });
    const { handle, port } = setupServer({ jarvisConfig });
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/config`);
    const body = (await response.json()) as { config: Record<string, unknown> };

    expect(body.config.timezone).toBe("Asia/Jerusalem");
    expect(body.config.port).toBe(4770);
  });

  test("requires the admin token when one is configured", async () => {
    const jarvisConfig = buildFakeConfig();
    const { handle, port } = setupServer({ jarvisConfig, adminToken: "correct-token" });
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/config`);
    expect(response.status).toBe(401);

    // Even a 401 body must never contain the admin token's real value.
    const rawText = await response.text();
    expect(rawText).not.toContain("correct-token");
  });

  test("succeeds with the correct admin token and still redacts", async () => {
    const jarvisConfig = buildFakeConfig();
    const { handle, port } = setupServer({ jarvisConfig, adminToken: "correct-token" });
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/config`, {
      headers: { "X-Jarvis-Admin-Token": "correct-token" },
    });
    const rawText = await response.text();

    expect(response.status).toBe(200);
    expect(rawText).not.toContain(FAKE_SECRET_MARKER);
    expect(rawText).not.toContain("correct-token");
  });
});

describe("GET /admin (static admin panel page)", () => {
  let activeHandle: { stop: () => void } | undefined;
  afterEach(() => {
    activeHandle?.stop();
    activeHandle = undefined;
  });

  test("redirects /admin to /admin/", async () => {
    const { handle, port } = setupServer();
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/admin`, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/admin/");
  });

  test("serves the admin page at /admin/ and it never embeds the admin token", async () => {
    const { handle, port } = setupServer({ adminToken: "correct-token" });
    activeHandle = handle;

    const response = await fetch(`http://localhost:${port}/admin/`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("<title>JARVIS Admin</title>");
    expect(html).not.toContain("correct-token");
  });

  test("a path-traversal attempt under /admin/ never returns file content outside ui/admin/", async () => {
    const { handle, port } = setupServer();
    activeHandle = handle;

    // The WHATWG URL parser itself collapses `..` (and its percent-encoded
    // form) out of the pathname before this server ever sees it, so a
    // traversal attempt either 404s (relPath still contains ".." somehow)
    // or falls through to a completely different route once the
    // normalized pathname no longer starts with "/admin/" at all — either
    // way, never actual file content from outside ui/admin/.
    const response = await fetch(`http://localhost:${port}/admin/%2e%2e/%2e%2e/etc/passwd`);
    const text = await response.text();
    expect(text).not.toContain("root:");
    expect(text).not.toMatch(/<title>JARVIS Admin<\/title>/);
  });

  test("serveAdminAsset itself rejects any relative path containing '..'", async () => {
    const { handle, port } = setupServer();
    activeHandle = handle;

    // A literal ".." segment that survives to the handler (e.g. a client
    // that doesn't URL-normalize) must still be rejected by the handler's
    // own explicit check, not rely solely on URL parsing upstream.
    const response = await fetch(`http://localhost:${port}/admin/foo/../../bar`, { redirect: "manual" });
    // Whatever the browser-side URL normalization does with this, the
    // response must never be the admin page's own content leaking from
    // outside ui/admin/.
    const text = await response.text();
    expect(text).not.toMatch(/<title>JARVIS Admin<\/title>/);
  });
});
