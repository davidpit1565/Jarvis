import { describe, test, expect } from "bun:test";
import { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import { DeviceStatus, DeviceType } from "@/types/devices";

describe("DeviceRegistry", () => {
  test("registers a device with UNKNOWN initial status", () => {
    const registry = new DeviceRegistry();
    const device = registry.registerDevice({
      id: "macbook-1",
      name: "David's MacBook",
      type: DeviceType.MAC,
      platform: "macOS",
    });

    expect(device.status).toBe(DeviceStatus.UNKNOWN);
    expect(device.lastSeen).toBeNull();
  });

  test("retrieves a registered device by id", () => {
    const registry = new DeviceRegistry();
    registry.registerDevice({ id: "iphone-1", name: "iPhone", type: DeviceType.IPHONE, platform: "iOS" });

    expect(registry.getDevice("iphone-1")?.name).toBe("iPhone");
  });

  test("lists all registered devices", () => {
    const registry = new DeviceRegistry();
    registry.registerDevice({ id: "a", name: "A", type: DeviceType.MAC, platform: "macOS" });
    registry.registerDevice({ id: "b", name: "B", type: DeviceType.IPHONE, platform: "iOS" });

    expect(registry.listDevices()).toHaveLength(2);
  });

  test("updates device status and lastSeen", () => {
    const registry = new DeviceRegistry();
    registry.registerDevice({ id: "a", name: "A", type: DeviceType.MAC, platform: "macOS" });

    const updated = registry.updateStatus("a", DeviceStatus.ONLINE);
    expect(updated.status).toBe(DeviceStatus.ONLINE);
    expect(updated.lastSeen).not.toBeNull();
  });

  test("throws when updating status of an unknown device", () => {
    const registry = new DeviceRegistry();
    expect(() => registry.updateStatus("missing", DeviceStatus.ONLINE)).toThrow();
  });
});
