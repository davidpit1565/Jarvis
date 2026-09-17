import { describe, test, expect } from "bun:test";
import { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import { DeviceStatus, DeviceType } from "@/types/devices";

const baseInput = {
  agentVersion: "0.1.0",
  protocolVersion: "1",
};

describe("DeviceRegistry", () => {
  test("registers a device with UNKNOWN initial status and no role", () => {
    const registry = new DeviceRegistry();
    const device = registry.registerDevice({
      id: "imac-1",
      name: "David's iMac",
      type: DeviceType.MAC,
      platform: "macos",
      ...baseInput,
    });

    expect(device.status).toBe(DeviceStatus.UNKNOWN);
    expect(device.lastSeen).toBeNull();
    expect(device.role).toBeNull();
  });

  test("retrieves a registered device by id", () => {
    const registry = new DeviceRegistry();
    registry.registerDevice({ id: "iphone-1", name: "iPhone", type: DeviceType.IPHONE, platform: "ios", ...baseInput });

    expect(registry.getDevice("iphone-1")?.name).toBe("iPhone");
  });

  test("lists all registered devices", () => {
    const registry = new DeviceRegistry();
    registry.registerDevice({ id: "a", name: "A", type: DeviceType.MAC, platform: "macos", ...baseInput });
    registry.registerDevice({ id: "b", name: "B", type: DeviceType.IPHONE, platform: "ios", ...baseInput });

    expect(registry.listDevices()).toHaveLength(2);
  });

  test("updates device status and lastSeen", () => {
    const registry = new DeviceRegistry();
    registry.registerDevice({ id: "a", name: "A", type: DeviceType.MAC, platform: "macos", ...baseInput });

    const updated = registry.updateStatus("a", DeviceStatus.ONLINE);
    expect(updated.status).toBe(DeviceStatus.ONLINE);
    expect(updated.lastSeen).not.toBeNull();
  });

  test("throws when updating status of an unknown device", () => {
    const registry = new DeviceRegistry();
    expect(() => registry.updateStatus("missing", DeviceStatus.ONLINE)).toThrow();
  });

  test("a requested role in registration input is never auto-assigned", () => {
    const registry = new DeviceRegistry();
    const device = registry.registerDevice({
      id: "imac-1",
      name: "iMac",
      type: DeviceType.MAC,
      platform: "macos",
      requestedRole: "primary",
      ...baseInput,
    });

    // The device asked for "primary" but Core never grants a role automatically.
    expect(device.role).toBeNull();
    expect(registry.getPrimaryDevice()).toBeUndefined();
  });

  test("setRole assigns a primary device", () => {
    const registry = new DeviceRegistry();
    registry.registerDevice({ id: "imac-1", name: "iMac", type: DeviceType.MAC, platform: "macos", ...baseInput });

    const updated = registry.setRole("imac-1", "primary");
    expect(updated.role).toBe("primary");
    expect(registry.getPrimaryDevice()?.id).toBe("imac-1");
  });

  test("setRole assigns secondary and mobile roles", () => {
    const registry = new DeviceRegistry();
    registry.registerDevice({ id: "macbook-1", name: "MacBook", type: DeviceType.MAC, platform: "macos", ...baseInput });
    registry.registerDevice({ id: "iphone-1", name: "iPhone", type: DeviceType.IPHONE, platform: "ios", ...baseInput });

    registry.setRole("macbook-1", "secondary");
    registry.setRole("iphone-1", "mobile");

    expect(registry.getDevice("macbook-1")?.role).toBe("secondary");
    expect(registry.getDevice("iphone-1")?.role).toBe("mobile");
  });

  test("getPrimaryDevice returns undefined when no device is primary", () => {
    const registry = new DeviceRegistry();
    registry.registerDevice({ id: "macbook-1", name: "MacBook", type: DeviceType.MAC, platform: "macos", ...baseInput });

    expect(registry.getPrimaryDevice()).toBeUndefined();
  });

  test("prevents assigning primary to a second device while one is already primary", () => {
    const registry = new DeviceRegistry();
    registry.registerDevice({ id: "imac-1", name: "iMac", type: DeviceType.MAC, platform: "macos", ...baseInput });
    registry.registerDevice({ id: "macbook-1", name: "MacBook", type: DeviceType.MAC, platform: "macos", ...baseInput });

    registry.setRole("imac-1", "primary");

    expect(() => registry.setRole("macbook-1", "primary")).toThrow();
    expect(registry.getPrimaryDevice()?.id).toBe("imac-1");
  });

  test("re-assigning the same device to primary is a no-op, not an error", () => {
    const registry = new DeviceRegistry();
    registry.registerDevice({ id: "imac-1", name: "iMac", type: DeviceType.MAC, platform: "macos", ...baseInput });

    registry.setRole("imac-1", "primary");
    expect(() => registry.setRole("imac-1", "primary")).not.toThrow();
    expect(registry.getPrimaryDevice()?.id).toBe("imac-1");
  });

  test("throws when setting a role on an unknown device", () => {
    const registry = new DeviceRegistry();
    expect(() => registry.setRole("missing", "primary")).toThrow();
  });
});
