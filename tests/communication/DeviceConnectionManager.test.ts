import { describe, test, expect } from "bun:test";
import { EventBus } from "@/core/events/EventBus";
import { DeviceConnectionManager, type DeviceConnection } from "@/communication/websocket/DeviceConnectionManager";
import type { ToolResultMessage } from "@/communication/websocket/protocol";

class MockDeviceConnection implements DeviceConnection {
  public sent: string[] = [];
  public closed = false;
  constructor(private readonly onSend?: (raw: string) => void) {}

  send(raw: string): void {
    this.sent.push(raw);
    this.onSend?.(raw);
  }

  close(): void {
    this.closed = true;
  }
}

function toolResultFor(raw: string, overrides: Partial<ToolResultMessage> = {}): ToolResultMessage {
  const envelope = JSON.parse(raw) as { requestId: string; deviceId: string };
  return {
    requestId: envelope.requestId,
    timestamp: new Date().toISOString(),
    deviceId: envelope.deviceId,
    type: "tool.result",
    payload: { success: true, data: { ok: true } },
    ...overrides,
  };
}

describe("DeviceConnectionManager", () => {
  test("registerConnection emits device.connected", () => {
    const eventBus = new EventBus();
    const manager = new DeviceConnectionManager(eventBus);
    const state: { received: { deviceId: string } | null } = { received: null };
    eventBus.on("device.connected", (payload) => (state.received = payload));

    manager.registerConnection("imac-1", new MockDeviceConnection());

    expect(state.received).toEqual({ deviceId: "imac-1" });
    expect(manager.hasConnection("imac-1")).toBe(true);
  });

  test("removeConnection emits device.disconnected only when a connection existed", () => {
    const eventBus = new EventBus();
    const manager = new DeviceConnectionManager(eventBus);
    const events: unknown[] = [];
    eventBus.on("device.disconnected", (payload) => events.push(payload));

    manager.removeConnection("never-connected");
    expect(events).toHaveLength(0);

    manager.registerConnection("imac-1", new MockDeviceConnection());
    manager.removeConnection("imac-1", "test_reason");
    expect(events).toEqual([{ deviceId: "imac-1", reason: "test_reason" }]);
    expect(manager.hasConnection("imac-1")).toBe(false);
  });

  test("pingAll sends a ping envelope to every connected device", () => {
    const eventBus = new EventBus();
    const manager = new DeviceConnectionManager(eventBus);
    const imac = new MockDeviceConnection();
    const iphone = new MockDeviceConnection();
    manager.registerConnection("imac-1", imac);
    manager.registerConnection("iphone-1", iphone);

    manager.pingAll();

    expect(imac.sent).toHaveLength(1);
    expect(iphone.sent).toHaveLength(1);
    const imacPing = JSON.parse(imac.sent[0]!) as { type: string; deviceId: string };
    expect(imacPing.type).toBe("ping");
    expect(imacPing.deviceId).toBe("imac-1");
  });

  test("pingAll does nothing when there are no connections", () => {
    const manager = new DeviceConnectionManager(new EventBus());
    expect(() => manager.pingAll()).not.toThrow();
  });

  test("removeConnection closes the underlying transport when it supports it", () => {
    const eventBus = new EventBus();
    const manager = new DeviceConnectionManager(eventBus);
    const connection = new MockDeviceConnection();

    manager.registerConnection("imac-1", connection);
    manager.removeConnection("imac-1", "revoked");

    expect(connection.closed).toBe(true);
  });

  test("sendToolRequest resolves once a matching tool.result arrives", async () => {
    const eventBus = new EventBus();
    const manager = new DeviceConnectionManager(eventBus);
    const connection = new MockDeviceConnection((raw) => {
      queueMicrotask(() => manager.handleToolResult(toolResultFor(raw)));
    });
    manager.registerConnection("imac-1", connection);

    const result = await manager.sendToolRequest("imac-1", "get_active_application", {});
    expect(result).toEqual({ success: true, data: { ok: true } });
  });

  test("sendToolRequest rejects immediately for an unknown device", async () => {
    const eventBus = new EventBus();
    const manager = new DeviceConnectionManager(eventBus);

    await expect(manager.sendToolRequest("missing-device", "some_tool", {})).rejects.toThrow(/Unknown device/);
  });

  test("sendToolRequest rejects on timeout and cleans up the pending entry", async () => {
    const eventBus = new EventBus();
    const manager = new DeviceConnectionManager(eventBus, 20);
    manager.registerConnection("imac-1", new MockDeviceConnection());

    await expect(manager.sendToolRequest("imac-1", "slow_tool", {})).rejects.toThrow(/timed out/i);

    // A late tool.result for the now-timed-out request must be a safe no-op.
    expect(() =>
      manager.handleToolResult({
        requestId: "irrelevant",
        timestamp: new Date().toISOString(),
        deviceId: "imac-1",
        type: "tool.result",
        payload: { success: true },
      })
    ).not.toThrow();
  });

  test("disconnecting a device rejects all of its pending tool requests", async () => {
    const eventBus = new EventBus();
    const manager = new DeviceConnectionManager(eventBus, 5000);
    const connection = new MockDeviceConnection(() => {
      queueMicrotask(() => manager.handleDisconnect("imac-1", "network_lost"));
    });
    manager.registerConnection("imac-1", connection);

    await expect(manager.sendToolRequest("imac-1", "some_tool", {})).rejects.toThrow(/disconnected/i);
  });

  test("disconnecting one device does not affect another device's pending request", async () => {
    const eventBus = new EventBus();
    const manager = new DeviceConnectionManager(eventBus, 5000);
    manager.registerConnection("imac-1", new MockDeviceConnection());
    const macbookConnection = new MockDeviceConnection((raw) => {
      queueMicrotask(() => manager.handleToolResult(toolResultFor(raw)));
    });
    manager.registerConnection("macbook-1", macbookConnection);

    const macbookResultPromise = manager.sendToolRequest("macbook-1", "some_tool", {});
    manager.handleDisconnect("imac-1", "unrelated");

    await expect(macbookResultPromise).resolves.toEqual({ success: true, data: { ok: true } });
  });

  test("a tool.result from a different device than the request was sent to is ignored", async () => {
    const eventBus = new EventBus();
    const manager = new DeviceConnectionManager(eventBus, 30);
    let capturedRequestId = "";
    manager.registerConnection(
      "imac-1",
      new MockDeviceConnection((raw) => {
        capturedRequestId = (JSON.parse(raw) as { requestId: string }).requestId;
      })
    );
    manager.registerConnection("macbook-1", new MockDeviceConnection());

    const resultPromise = manager.sendToolRequest("imac-1", "some_tool", {});
    await Promise.resolve();

    manager.handleToolResult({
      requestId: capturedRequestId,
      timestamp: new Date().toISOString(),
      deviceId: "macbook-1", // wrong device for this requestId
      type: "tool.result",
      payload: { success: true },
    });

    await expect(resultPromise).rejects.toThrow(/timed out/i);
  });

  test("handleToolResult for an unknown requestId does not throw", () => {
    const eventBus = new EventBus();
    const manager = new DeviceConnectionManager(eventBus);

    expect(() =>
      manager.handleToolResult({
        requestId: "never-sent",
        timestamp: new Date().toISOString(),
        deviceId: "imac-1",
        type: "tool.result",
        payload: { success: true },
      })
    ).not.toThrow();
  });

  test("send() throws for a device with no active connection", () => {
    const eventBus = new EventBus();
    const manager = new DeviceConnectionManager(eventBus);
    expect(() => manager.send("missing", "{}")).toThrow(/Unknown device connection/);
  });

  test("a connection whose send() throws synchronously rejects the tool request instead of hanging", async () => {
    const eventBus = new EventBus();
    const manager = new DeviceConnectionManager(eventBus);
    const throwingConnection: DeviceConnection = {
      send: () => {
        throw new Error("socket write failed");
      },
    };
    manager.registerConnection("imac-1", throwingConnection);

    await expect(manager.sendToolRequest("imac-1", "some_tool", {})).rejects.toThrow(/socket write failed/);
  });

  test("sendNotification sends a show_notification device.command with the given title/body", () => {
    const eventBus = new EventBus();
    const manager = new DeviceConnectionManager(eventBus);
    const connection = new MockDeviceConnection();
    manager.registerConnection("imac-1", connection);

    manager.sendNotification("imac-1", "JARVIS Reminder", "Call the dentist");

    expect(connection.sent).toHaveLength(1);
    const envelope = JSON.parse(connection.sent[0]!) as {
      deviceId: string;
      type: string;
      payload: { command: string; args: { title: string; body: string } };
    };
    expect(envelope.type).toBe("device.command");
    expect(envelope.deviceId).toBe("imac-1");
    expect(envelope.payload.command).toBe("show_notification");
    expect(envelope.payload.args).toEqual({ title: "JARVIS Reminder", body: "Call the dentist" });
  });

  test("sendNotification silently does nothing for a device with no active connection", () => {
    const eventBus = new EventBus();
    const manager = new DeviceConnectionManager(eventBus);
    expect(() => manager.sendNotification("missing", "Title", "Body")).not.toThrow();
  });
});
