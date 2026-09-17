import { describe, test, expect } from "bun:test";
import { EventBus } from "@/core/events/EventBus";

describe("EventBus", () => {
  test("delivers emitted payloads to subscribed listeners", () => {
    const bus = new EventBus();
    let received: unknown = null;

    bus.on("device.registered", (payload) => {
      received = payload;
    });

    const device = {
      id: "a",
      name: "A",
      type: "mac" as const,
      platform: "macOS",
      status: "unknown" as const,
      capabilities: [],
      lastSeen: null,
    };

    bus.emit("device.registered", { device });
    expect(received).toEqual({ device });
  });

  test("does not throw when emitting an event with no listeners", () => {
    const bus = new EventBus();
    expect(() => bus.emit("tool.requested", { toolCall: { id: "1", toolName: "x", input: {} } })).not.toThrow();
  });

  test("unsubscribe stops further delivery", () => {
    const bus = new EventBus();
    let callCount = 0;

    const unsubscribe = bus.on("brain.response", () => {
      callCount++;
    });

    bus.emit("brain.response", { text: "hi", toolCallCount: 0 });
    unsubscribe();
    bus.emit("brain.response", { text: "hi again", toolCallCount: 0 });

    expect(callCount).toBe(1);
  });
});
