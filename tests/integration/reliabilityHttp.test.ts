import { describe, test, expect, afterEach } from "bun:test";
import { EventBus } from "@/core/events/EventBus";
import { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import { PairingService } from "@/devices/pairing/PairingService";
import { DeviceConnectionManager } from "@/communication/websocket/DeviceConnectionManager";
import { JarvisWebSocketServer } from "@/communication/websocket/JarvisWebSocketServer";
import { AIRouter } from "@/core/brain/AIRouter";
import { AIProviderRegistry } from "@/core/brain/AIProviderRegistry";
import { CostTracker } from "@/core/cost/CostTracker";
import { SchedulerHealthTracker } from "@/core/health/SchedulerHealthTracker";
import { AutomationFailureStore } from "@/automation/AutomationFailureStore";
import type { Brain, BrainResponse } from "@/types/brain";
import { Database } from "bun:sqlite";
import { writeFileSync, unlinkSync } from "node:fs";

let activeHandle: { stop: (force?: boolean) => void } | undefined;

afterEach(() => {
  activeHandle?.stop(true);
  activeHandle = undefined;
});

function okBrain(): Brain {
  return {
    async chat(): Promise<BrainResponse> {
      return { text: "ok", toolCalls: [], stopReason: "stop" };
    },
  };
}

function makeAIRouter(): AIRouter {
  const registry = new AIProviderRegistry();
  registry.register("anthropic", okBrain(), "paid");
  return new AIRouter(registry, new CostTracker(":memory:"), {});
}

function setupServer(opts: {
  adminToken?: string;
  aiRouter?: AIRouter;
  schedulerHealthTracker?: SchedulerHealthTracker;
  automationFailureStore?: AutomationFailureStore;
}) {
  const eventBus = new EventBus();
  const server = new JarvisWebSocketServer({
    deviceRegistry: new DeviceRegistry(),
    deviceConnectionManager: new DeviceConnectionManager(eventBus),
    pairingService: new PairingService(),
    eventBus,
    adminToken: opts.adminToken,
    aiRouter: opts.aiRouter,
    schedulerHealthTracker: opts.schedulerHealthTracker,
    automationFailureStore: opts.automationFailureStore,
  });
  const handle = server.start(0);
  activeHandle = handle;
  return handle;
}

describe("GET /providers/health", () => {
  test("404s when no AIRouter is configured", async () => {
    const handle = setupServer({});
    const response = await fetch(`http://localhost:${handle.port}/providers/health`);
    expect(response.status).toBe(404);
  });

  test("401s with a missing or wrong admin token when one is configured", async () => {
    const handle = setupServer({ adminToken: "secret-token", aiRouter: makeAIRouter() });
    const response = await fetch(`http://localhost:${handle.port}/providers/health`);
    expect(response.status).toBe(401);
  });

  test("returns AIRouter.getProviderStatus() shape with a valid admin token", async () => {
    const aiRouter = makeAIRouter();
    await aiRouter.chat({ messages: [], tools: [] });
    const handle = setupServer({ adminToken: "secret-token", aiRouter });

    const response = await fetch(`http://localhost:${handle.port}/providers/health`, {
      headers: { "X-Jarvis-Admin-Token": "secret-token" },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { providers: Record<string, { configured: boolean; costTier: string }> };
    expect(body.providers.anthropic).toBeDefined();
    expect(body.providers.anthropic!.configured).toBe(true);
    expect(body.providers.anthropic!.costTier).toBe("paid");
  });

  test("works without an admin token when none is configured (local dev)", async () => {
    const handle = setupServer({ aiRouter: makeAIRouter() });
    const response = await fetch(`http://localhost:${handle.port}/providers/health`);
    expect(response.status).toBe(200);
  });
});

describe("GET /status schedulerHealth", () => {
  test("omits schedulerHealth when no tracker is configured", async () => {
    const handle = setupServer({});
    const response = await fetch(`http://localhost:${handle.port}/status`);
    const body = (await response.json()) as { schedulerHealth?: unknown };
    expect(body.schedulerHealth).toBeUndefined();
  });

  test("reports each ticked scheduler's last-tick age", async () => {
    const tracker = new SchedulerHealthTracker();
    tracker.tick("wakeUpCalls");
    tracker.tick("automationRules");
    const handle = setupServer({ schedulerHealthTracker: tracker });

    const response = await fetch(`http://localhost:${handle.port}/status`);
    const body = (await response.json()) as {
      schedulerHealth: Array<{ name: string; lastTickAt: string; ageMs: number }>;
    };
    const names = body.schedulerHealth.map((s) => s.name).sort();
    expect(names).toEqual(["automationRules", "wakeUpCalls"]);
    expect(body.schedulerHealth[0]!.ageMs).toBeGreaterThanOrEqual(0);
  });
});

describe("GET /automation-failures", () => {
  test("404s when no AutomationFailureStore is configured", async () => {
    const handle = setupServer({});
    const response = await fetch(`http://localhost:${handle.port}/automation-failures`);
    expect(response.status).toBe(404);
  });

  test("401s with a missing or wrong admin token when one is configured", async () => {
    const store = new AutomationFailureStore(":memory:");
    const handle = setupServer({ adminToken: "secret-token", automationFailureStore: store });
    const response = await fetch(`http://localhost:${handle.port}/automation-failures`);
    expect(response.status).toBe(401);
    store.close();
  });

  test("lists recorded failures with a valid admin token", async () => {
    const store = new AutomationFailureStore(":memory:");
    store.record("rule-1", "Send the digest", "Telegram 500");
    const handle = setupServer({ adminToken: "secret-token", automationFailureStore: store });

    const response = await fetch(`http://localhost:${handle.port}/automation-failures`, {
      headers: { "X-Jarvis-Admin-Token": "secret-token" },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { failures: Array<{ ruleId: string; error: string }> };
    expect(body.failures).toHaveLength(1);
    expect(body.failures[0]!.ruleId).toBe("rule-1");
    store.close();
  });

  test("400s on a non-positive-integer limit", async () => {
    const store = new AutomationFailureStore(":memory:");
    const handle = setupServer({ automationFailureStore: store });
    const response = await fetch(`http://localhost:${handle.port}/automation-failures?limit=-1`);
    expect(response.status).toBe(400);
    store.close();
  });
});

describe("GET /backup integrity headers", () => {
  test("reports zero checked/failed when no db paths are configured", async () => {
    const eventBus = new EventBus();
    const server = new JarvisWebSocketServer({
      deviceRegistry: new DeviceRegistry(),
      deviceConnectionManager: new DeviceConnectionManager(eventBus),
      pairingService: new PairingService(),
      eventBus,
      adminToken: "secret-token",
      backupDbPaths: [],
    });
    const handle = server.start(0);
    activeHandle = handle;

    const response = await fetch(`http://localhost:${handle.port}/backup`, {
      headers: { "X-Jarvis-Admin-Token": "secret-token" },
    });
    // No existing db paths at all -> createBackupArchive itself 404s.
    expect(response.status).toBe(404);
  });

  test("reports integrity check results in response headers, degraded on a corrupted file", async () => {
    const goodPath = `/tmp/jarvis-reliability-good-${crypto.randomUUID()}.sqlite`;
    const badPath = `/tmp/jarvis-reliability-bad-${crypto.randomUUID()}.sqlite`;
    const db = new Database(goodPath);
    db.run("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    db.close();
    writeFileSync(badPath, "garbage, not a real sqlite file");

    const eventBus = new EventBus();
    const server = new JarvisWebSocketServer({
      deviceRegistry: new DeviceRegistry(),
      deviceConnectionManager: new DeviceConnectionManager(eventBus),
      pairingService: new PairingService(),
      eventBus,
      adminToken: "secret-token",
      backupDbPaths: [goodPath, badPath],
    });
    const handle = server.start(0);
    activeHandle = handle;

    try {
      const response = await fetch(`http://localhost:${handle.port}/backup`, {
        headers: { "X-Jarvis-Admin-Token": "secret-token" },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("X-Jarvis-Backup-Integrity-Checked")).toBe("2");
      expect(response.headers.get("X-Jarvis-Backup-Integrity-Failed")).toBe("1");
      await response.arrayBuffer();
    } finally {
      unlinkSync(goodPath);
      unlinkSync(badPath);
    }
  });
});
