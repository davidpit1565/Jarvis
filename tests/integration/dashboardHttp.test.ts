import { describe, test, expect, afterEach } from "bun:test";
import { EventBus } from "@/core/events/EventBus";
import { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import { PairingService } from "@/devices/pairing/PairingService";
import { DeviceConnectionManager } from "@/communication/websocket/DeviceConnectionManager";
import { JarvisWebSocketServer } from "@/communication/websocket/JarvisWebSocketServer";
import { ToolRegistry } from "@/tools/registry/ToolRegistry";
import { ActivityLog } from "@/core/activity/ActivityLog";
import { TokenUsageStore } from "@/audit/TokenUsageStore";
import { ToolAuditLog } from "@/audit/ToolAuditLog";
import { ReminderStore } from "@/reminders/ReminderStore";
import { MemoryStore } from "@/memory/MemoryStore";
import { ConversationHistoryStore } from "@/history/ConversationHistoryStore";
import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";

function makeTool(id: string): LocalTool {
  return {
    id,
    name: id.toLowerCase(),
    description: "A test tool",
    inputSchema: { type: "object", properties: {} },
    requiredPermission: PermissionLevel.READ,
    target: "local",
    execute: async () => ({ success: true }),
  };
}

describe("Dashboard HTTP routes", () => {
  let activeHandle: { stop: () => void } | undefined;

  afterEach(() => {
    activeHandle?.stop();
    activeHandle = undefined;
  });

  test("GET / serves the dashboard HTML", async () => {
    const eventBus = new EventBus();
    const server = new JarvisWebSocketServer({
      deviceRegistry: new DeviceRegistry(),
      deviceConnectionManager: new DeviceConnectionManager(eventBus),
      pairingService: new PairingService(),
      eventBus,
    });
    const handle = server.start(0);
    activeHandle = handle;

    const response = await fetch(`http://localhost:${handle.port}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html");
    const body = await response.text();
    expect(body).toContain("JARVIS");
    expect(body).toContain("/status");
  });

  test("every response carries basic security headers", async () => {
    const eventBus = new EventBus();
    const server = new JarvisWebSocketServer({
      deviceRegistry: new DeviceRegistry(),
      deviceConnectionManager: new DeviceConnectionManager(eventBus),
      pairingService: new PairingService(),
      eventBus,
    });
    const handle = server.start(0);
    activeHandle = handle;

    const responses = await Promise.all([
      fetch(`http://localhost:${handle.port}/`),
      fetch(`http://localhost:${handle.port}/health`),
      fetch(`http://localhost:${handle.port}/status`),
    ]);

    for (const response of responses) {
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("X-Frame-Options")).toBe("DENY");
      expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    }
  });

  test("GET /health reports ok with an uptime, unauthenticated", async () => {
    const eventBus = new EventBus();
    const server = new JarvisWebSocketServer({
      deviceRegistry: new DeviceRegistry(),
      deviceConnectionManager: new DeviceConnectionManager(eventBus),
      pairingService: new PairingService(),
      eventBus,
    });
    const handle = server.start(0);
    activeHandle = handle;

    const response = await fetch(`http://localhost:${handle.port}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; uptimeSeconds: number; version: string; commit: string | null };
    expect(body.status).toBe("ok");
    expect(typeof body.uptimeSeconds).toBe("number");
    expect(typeof body.version).toBe("string");
    expect(body.version.length).toBeGreaterThan(0);
  });

  test("GET /health reports commit as null when JARVIS_COMMIT_SHA isn't set", async () => {
    const original = process.env.JARVIS_COMMIT_SHA;
    delete process.env.JARVIS_COMMIT_SHA;
    try {
      const eventBus = new EventBus();
      const server = new JarvisWebSocketServer({
        deviceRegistry: new DeviceRegistry(),
        deviceConnectionManager: new DeviceConnectionManager(eventBus),
        pairingService: new PairingService(),
        eventBus,
      });
      const handle = server.start(0);
      activeHandle = handle;

      const body = (await (await fetch(`http://localhost:${handle.port}/health`)).json()) as { commit: string | null };
      expect(body.commit).toBeNull();
    } finally {
      if (original !== undefined) process.env.JARVIS_COMMIT_SHA = original;
    }
  });

  test("GET /health reports the configured commit when JARVIS_COMMIT_SHA is set", async () => {
    const original = process.env.JARVIS_COMMIT_SHA;
    process.env.JARVIS_COMMIT_SHA = "abc1234";
    try {
      const eventBus = new EventBus();
      const server = new JarvisWebSocketServer({
        deviceRegistry: new DeviceRegistry(),
        deviceConnectionManager: new DeviceConnectionManager(eventBus),
        pairingService: new PairingService(),
        eventBus,
      });
      const handle = server.start(0);
      activeHandle = handle;

      const body = (await (await fetch(`http://localhost:${handle.port}/health`)).json()) as { commit: string | null };
      expect(body.commit).toBe("abc1234");
    } finally {
      if (original === undefined) delete process.env.JARVIS_COMMIT_SHA;
      else process.env.JARVIS_COMMIT_SHA = original;
    }
  });

  test("GET /dashboard serves the same page as GET /", async () => {
    const eventBus = new EventBus();
    const server = new JarvisWebSocketServer({
      deviceRegistry: new DeviceRegistry(),
      deviceConnectionManager: new DeviceConnectionManager(eventBus),
      pairingService: new PairingService(),
      eventBus,
    });
    const handle = server.start(0);
    activeHandle = handle;

    const response = await fetch(`http://localhost:${handle.port}/dashboard`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html");
  });

  test("GET /status reports registered devices, tools, and phone gateway state", async () => {
    const eventBus = new EventBus();
    const deviceRegistry = new DeviceRegistry();
    deviceRegistry.registerDevice({
      id: "imac-1",
      name: "Office iMac",
      type: "mac",
      platform: "macos",
      agentVersion: "0.1.0",
      protocolVersion: "1",
    });
    deviceRegistry.setRole("imac-1", "primary");
    deviceRegistry.updateStatus("imac-1", "online");

    const toolRegistry = new ToolRegistry();
    toolRegistry.registerTool(makeTool("SAVE_MEMORY"));

    const server = new JarvisWebSocketServer({
      deviceRegistry,
      deviceConnectionManager: new DeviceConnectionManager(eventBus),
      pairingService: new PairingService(),
      eventBus,
      toolRegistry,
    });
    const handle = server.start(0);
    activeHandle = handle;

    const response = await fetch(`http://localhost:${handle.port}/status`);
    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      devices: unknown[];
      tools: unknown[];
      phoneGatewayEnabled: boolean;
    };

    expect(data.devices).toEqual([
      expect.objectContaining({ id: "imac-1", name: "Office iMac", role: "primary", status: "online" }),
    ]);
    expect(data.tools).toEqual([{ name: "save_memory", target: "local" }]);
    expect(data.phoneGatewayEnabled).toBe(false);
  });

  test("GET /status reflects an enabled phone gateway", async () => {
    const eventBus = new EventBus();
    const server = new JarvisWebSocketServer({
      deviceRegistry: new DeviceRegistry(),
      deviceConnectionManager: new DeviceConnectionManager(eventBus),
      pairingService: new PairingService(),
      eventBus,
      phoneGateway: {} as never, // presence alone is what /status reports on
    });
    const handle = server.start(0);
    activeHandle = handle;

    const response = await fetch(`http://localhost:${handle.port}/status`);
    const data = (await response.json()) as { phoneGatewayEnabled: boolean };
    expect(data.phoneGatewayEnabled).toBe(true);
  });

  test("GET /status omits tokenUsage when no TokenUsageStore is configured", async () => {
    const eventBus = new EventBus();
    const server = new JarvisWebSocketServer({
      deviceRegistry: new DeviceRegistry(),
      deviceConnectionManager: new DeviceConnectionManager(eventBus),
      pairingService: new PairingService(),
      eventBus,
    });
    const handle = server.start(0);
    activeHandle = handle;

    const response = await fetch(`http://localhost:${handle.port}/status`);
    const data = (await response.json()) as { tokenUsage?: unknown };
    expect(data.tokenUsage).toBeUndefined();
  });

  test("GET /status reports token usage totals and an estimated cost", async () => {
    const eventBus = new EventBus();
    const tokenUsageStore = new TokenUsageStore(":memory:");
    tokenUsageStore.record({ inputTokens: 1000, outputTokens: 500, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 });

    const server = new JarvisWebSocketServer({
      deviceRegistry: new DeviceRegistry(),
      deviceConnectionManager: new DeviceConnectionManager(eventBus),
      pairingService: new PairingService(),
      eventBus,
      tokenUsageStore,
    });
    const handle = server.start(0);
    activeHandle = handle;

    const response = await fetch(`http://localhost:${handle.port}/status`);
    const data = (await response.json()) as {
      tokenUsage: { inputTokens: number; outputTokens: number; calls: number; estimatedCostUsd: number | null };
    };

    expect(data.tokenUsage.inputTokens).toBe(1000);
    expect(data.tokenUsage.outputTokens).toBe(500);
    expect(data.tokenUsage.calls).toBe(1);
    expect(data.tokenUsage.estimatedCostUsd).not.toBeNull();
    tokenUsageStore.close();
  });

  test("GET /status reports a tool-usage summary from ToolAuditLog", async () => {
    const eventBus = new EventBus();
    const toolAuditLog = new ToolAuditLog(":memory:");
    toolAuditLog.record("save_memory", "user-1", {}, { success: true });
    toolAuditLog.record("save_memory", "user-1", {}, { success: false, error: "boom" });

    const server = new JarvisWebSocketServer({
      deviceRegistry: new DeviceRegistry(),
      deviceConnectionManager: new DeviceConnectionManager(eventBus),
      pairingService: new PairingService(),
      eventBus,
      toolAuditLog,
    });
    const handle = server.start(0);
    activeHandle = handle;

    const response = await fetch(`http://localhost:${handle.port}/status`);
    const data = (await response.json()) as {
      toolUsage: { totalCalls: number; errorCount: number; mostUsedTool: string | null };
    };

    expect(data.toolUsage.totalCalls).toBe(2);
    expect(data.toolUsage.errorCount).toBe(1);
    expect(data.toolUsage.mostUsedTool).toBe("save_memory");
    toolAuditLog.close();
  });

  test("GET /status reports memory/reminders/conversation-history counts", async () => {
    const eventBus = new EventBus();
    const reminderStore = new ReminderStore(":memory:");
    const memoryStore = new MemoryStore(":memory:");
    const conversationHistoryStore = new ConversationHistoryStore(":memory:");

    reminderStore.create({ text: "Buy milk" });
    const r2 = reminderStore.create({ text: "Call mom" });
    reminderStore.complete(r2.id);
    memoryStore.save({ key: "user.name", value: "David" });
    conversationHistoryStore.record("user", "hello");

    const server = new JarvisWebSocketServer({
      deviceRegistry: new DeviceRegistry(),
      deviceConnectionManager: new DeviceConnectionManager(eventBus),
      pairingService: new PairingService(),
      eventBus,
      reminderStore,
      memoryStore,
      conversationHistoryStore,
    });
    const handle = server.start(0);
    activeHandle = handle;

    const response = await fetch(`http://localhost:${handle.port}/status`);
    const data = (await response.json()) as {
      counts: { memory: number; reminders: number; pendingReminders: number; conversationHistory: number };
    };

    expect(data.counts.memory).toBe(1);
    expect(data.counts.reminders).toBe(2);
    expect(data.counts.pendingReminders).toBe(1);
    expect(data.counts.conversationHistory).toBe(1);

    reminderStore.close();
    memoryStore.close();
    conversationHistoryStore.close();
  });

  test("GET /status includes recent activity log entries, newest first", async () => {
    const eventBus = new EventBus();
    const activityLog = new ActivityLog();
    activityLog.record("first thing happened");
    activityLog.record("second thing happened");

    const server = new JarvisWebSocketServer({
      deviceRegistry: new DeviceRegistry(),
      deviceConnectionManager: new DeviceConnectionManager(eventBus),
      pairingService: new PairingService(),
      eventBus,
      activityLog,
    });
    const handle = server.start(0);
    activeHandle = handle;

    const response = await fetch(`http://localhost:${handle.port}/status`);
    const data = (await response.json()) as { activity: { message: string; kind: string }[] };

    expect(data.activity.map((a) => a.message)).toEqual(["second thing happened", "first thing happened"]);
    expect(data.activity.every((a) => a.kind === "info")).toBe(true);
  });

  test("GET /status returns an empty activity list when no ActivityLog is configured", async () => {
    const eventBus = new EventBus();
    const server = new JarvisWebSocketServer({
      deviceRegistry: new DeviceRegistry(),
      deviceConnectionManager: new DeviceConnectionManager(eventBus),
      pairingService: new PairingService(),
      eventBus,
    });
    const handle = server.start(0);
    activeHandle = handle;

    const response = await fetch(`http://localhost:${handle.port}/status`);
    const data = (await response.json()) as { activity: unknown[] };
    expect(data.activity).toEqual([]);
  });

  test("GET /assets/hologram.jpg serves the hero image", async () => {
    const eventBus = new EventBus();
    const server = new JarvisWebSocketServer({
      deviceRegistry: new DeviceRegistry(),
      deviceConnectionManager: new DeviceConnectionManager(eventBus),
      pairingService: new PairingService(),
      eventBus,
    });
    const handle = server.start(0);
    activeHandle = handle;

    const response = await fetch(`http://localhost:${handle.port}/assets/hologram.jpg`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/jpeg");
    const bytes = await response.arrayBuffer();
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  test("a WebSocket upgrade request to \"/\" still connects instead of getting the HTML page", async () => {
    const eventBus = new EventBus();
    const server = new JarvisWebSocketServer({
      deviceRegistry: new DeviceRegistry(),
      deviceConnectionManager: new DeviceConnectionManager(eventBus),
      pairingService: new PairingService(),
      eventBus,
    });
    const handle = server.start(0);
    activeHandle = handle;

    const opened = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://localhost:${handle.port}/`);
      ws.onopen = () => {
        ws.close();
        resolve(true);
      };
      ws.onerror = () => resolve(false);
    });

    expect(opened).toBe(true);
  });
});
