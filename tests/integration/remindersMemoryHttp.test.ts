import { describe, test, expect, afterEach } from "bun:test";
import { EventBus } from "@/core/events/EventBus";
import { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import { PairingService } from "@/devices/pairing/PairingService";
import { DeviceConnectionManager } from "@/communication/websocket/DeviceConnectionManager";
import { JarvisWebSocketServer } from "@/communication/websocket/JarvisWebSocketServer";
import { ReminderStore } from "@/reminders/ReminderStore";
import { MemoryStore } from "@/memory/MemoryStore";
import { WakeUpCallStore } from "@/wakeup/WakeUpCallStore";

let activeHandle: { stop: (force?: boolean) => void } | undefined;

afterEach(() => {
  activeHandle?.stop(true);
  activeHandle = undefined;
});

function setupServer(opts: {
  adminToken?: string;
  reminderStore?: ReminderStore;
  memoryStore?: MemoryStore;
  wakeUpCallStore?: WakeUpCallStore;
}) {
  const eventBus = new EventBus();
  const server = new JarvisWebSocketServer({
    deviceRegistry: new DeviceRegistry(),
    deviceConnectionManager: new DeviceConnectionManager(eventBus),
    pairingService: new PairingService(),
    eventBus,
    adminToken: opts.adminToken,
    reminderStore: opts.reminderStore,
    memoryStore: opts.memoryStore,
    wakeUpCallStore: opts.wakeUpCallStore,
  });
  const handle = server.start(0);
  activeHandle = handle;
  return handle;
}

describe("GET /reminders", () => {
  test("404s when no ReminderStore is configured", async () => {
    const handle = setupServer({});
    const response = await fetch(`http://localhost:${handle.port}/reminders`);
    expect(response.status).toBe(404);
  });

  test("401s with a missing or wrong admin token when one is configured", async () => {
    const reminderStore = new ReminderStore(":memory:");
    const handle = setupServer({ adminToken: "secret-token", reminderStore });

    const response = await fetch(`http://localhost:${handle.port}/reminders`);
    expect(response.status).toBe(401);
    reminderStore.close();
  });

  test("lists all reminders, including completed, with a valid admin token", async () => {
    const reminderStore = new ReminderStore(":memory:");
    const r1 = reminderStore.create({ text: "Buy milk" });
    reminderStore.create({ text: "Call mom" });
    reminderStore.complete(r1.id);

    const handle = setupServer({ adminToken: "secret-token", reminderStore });
    const response = await fetch(`http://localhost:${handle.port}/reminders`, {
      headers: { "X-Jarvis-Admin-Token": "secret-token" },
    });

    expect(response.status).toBe(200);
    const data = (await response.json()) as { reminders: { text: string; completed: boolean }[] };
    expect(data.reminders).toHaveLength(2);
    expect(data.reminders.some((r) => r.text === "Buy milk" && r.completed)).toBe(true);
    reminderStore.close();
  });

  test("works without an admin token when none is configured (local dev)", async () => {
    const reminderStore = new ReminderStore(":memory:");
    reminderStore.create({ text: "Buy milk" });

    const handle = setupServer({ reminderStore });
    const response = await fetch(`http://localhost:${handle.port}/reminders`);
    expect(response.status).toBe(200);
    reminderStore.close();
  });
});

describe("GET /memory", () => {
  test("404s when no MemoryStore is configured", async () => {
    const handle = setupServer({});
    const response = await fetch(`http://localhost:${handle.port}/memory`);
    expect(response.status).toBe(404);
  });

  test("401s with a missing or wrong admin token when one is configured", async () => {
    const memoryStore = new MemoryStore(":memory:");
    const handle = setupServer({ adminToken: "secret-token", memoryStore });

    const response = await fetch(`http://localhost:${handle.port}/memory`, {
      headers: { "X-Jarvis-Admin-Token": "wrong" },
    });
    expect(response.status).toBe(401);
    memoryStore.close();
  });

  test("lists all saved memory facts with a valid admin token", async () => {
    const memoryStore = new MemoryStore(":memory:");
    memoryStore.save({ key: "user.name", value: "David" });
    memoryStore.save({ key: "user.city", value: "Tel Aviv" });

    const handle = setupServer({ adminToken: "secret-token", memoryStore });
    const response = await fetch(`http://localhost:${handle.port}/memory`, {
      headers: { "X-Jarvis-Admin-Token": "secret-token" },
    });

    expect(response.status).toBe(200);
    const data = (await response.json()) as { memory: { key: string; value: string }[] };
    expect(data.memory).toHaveLength(2);
    expect(data.memory.some((m) => m.key === "user.name" && m.value === "David")).toBe(true);
    memoryStore.close();
  });
});

describe("GET /wakeup-calls", () => {
  test("404s when no WakeUpCallStore is configured", async () => {
    const handle = setupServer({});
    const response = await fetch(`http://localhost:${handle.port}/wakeup-calls`);
    expect(response.status).toBe(404);
  });

  test("401s with a missing or wrong admin token when one is configured", async () => {
    const wakeUpCallStore = new WakeUpCallStore(":memory:");
    const handle = setupServer({ adminToken: "secret-token", wakeUpCallStore });

    const response = await fetch(`http://localhost:${handle.port}/wakeup-calls`);
    expect(response.status).toBe(401);
    wakeUpCallStore.close();
  });

  test("lists the wake-up call schedule with a valid admin token", async () => {
    const wakeUpCallStore = new WakeUpCallStore(":memory:");
    wakeUpCallStore.create({ timeOfDay: "07:00", label: "weekday" });

    const handle = setupServer({ adminToken: "secret-token", wakeUpCallStore });
    const response = await fetch(`http://localhost:${handle.port}/wakeup-calls`, {
      headers: { "X-Jarvis-Admin-Token": "secret-token" },
    });

    expect(response.status).toBe(200);
    const data = (await response.json()) as { wakeUpCalls: { timeOfDay: string; label: string | null }[] };
    expect(data.wakeUpCalls).toHaveLength(1);
    expect(data.wakeUpCalls[0]?.timeOfDay).toBe("07:00");
    wakeUpCallStore.close();
  });

  test("works without an admin token when none is configured (local dev)", async () => {
    const wakeUpCallStore = new WakeUpCallStore(":memory:");
    const handle = setupServer({ wakeUpCallStore });
    const response = await fetch(`http://localhost:${handle.port}/wakeup-calls`);
    expect(response.status).toBe(200);
    wakeUpCallStore.close();
  });
});
