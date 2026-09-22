import { describe, test, expect } from "bun:test";
import { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import { DeviceRole, DeviceStatus, DeviceType } from "@/types/devices";

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

  test("a new device starts with no reported permissions", () => {
    const registry = new DeviceRegistry();
    const device = registry.registerDevice({ id: "imac-1", name: "iMac", type: DeviceType.MAC, platform: "macos", ...baseInput });
    expect(device.permissions).toBeNull();
  });

  test("updateCapabilities records a device's self-reported permission status", () => {
    const registry = new DeviceRegistry();
    registry.registerDevice({ id: "imac-1", name: "iMac", type: DeviceType.MAC, platform: "macos", ...baseInput });

    const updated = registry.updateCapabilities("imac-1", { accessibility: "granted", microphone: "denied" });
    expect(updated.permissions).toEqual({ accessibility: "granted", microphone: "denied" });
    expect(registry.getDevice("imac-1")?.permissions).toEqual({ accessibility: "granted", microphone: "denied" });
  });

  test("updateCapabilities replaces rather than merges the previous permission map", () => {
    const registry = new DeviceRegistry();
    registry.registerDevice({ id: "imac-1", name: "iMac", type: DeviceType.MAC, platform: "macos", ...baseInput });

    registry.updateCapabilities("imac-1", { accessibility: "granted", microphone: "granted" });
    registry.updateCapabilities("imac-1", { accessibility: "granted" });

    expect(registry.getDevice("imac-1")?.permissions).toEqual({ accessibility: "granted" });
  });

  test("throws when updating capabilities of an unknown device", () => {
    const registry = new DeviceRegistry();
    expect(() => registry.updateCapabilities("missing", { accessibility: "granted" })).toThrow();
  });
});

describe("DeviceRegistry persistence", () => {
  test("a device and its assigned role survive across instances backed by the same SQLite file", () => {
    const dbPath = `/tmp/jarvis-devices-test-${crypto.randomUUID()}.sqlite`;

    const first = new DeviceRegistry(dbPath);
    first.registerDevice({ id: "imac-1", name: "David's iMac", type: DeviceType.MAC, platform: "macos", ...baseInput });
    first.setRole("imac-1", "primary");
    first.close();

    const second = new DeviceRegistry(dbPath);
    const device = second.getDevice("imac-1");
    expect(device?.role).toBe("primary");
    expect(device?.name).toBe("David's iMac");
    expect(second.getPrimaryDevice()?.id).toBe("imac-1");
    second.close();
  });

  test("a reloaded device starts UNKNOWN/not-seen, never assumed online from before the restart", () => {
    const dbPath = `/tmp/jarvis-devices-test-${crypto.randomUUID()}.sqlite`;

    const first = new DeviceRegistry(dbPath);
    first.registerDevice({ id: "imac-1", name: "David's iMac", type: DeviceType.MAC, platform: "macos", ...baseInput });
    first.updateStatus("imac-1", DeviceStatus.ONLINE);
    first.close();

    const second = new DeviceRegistry(dbPath);
    const device = second.getDevice("imac-1");
    expect(device?.status).toBe(DeviceStatus.UNKNOWN);
    expect(device?.lastSeen).toBeNull();
    second.close();
  });

  test("with no dbPath, behaves purely in-memory (no persistence)", () => {
    const registry = new DeviceRegistry();
    registry.registerDevice({ id: "imac-1", name: "iMac", type: DeviceType.MAC, platform: "macos", ...baseInput });
    registry.close(); // must not throw with no backing db
  });
});

describe("DeviceRegistry.updateRegistrationMetadata", () => {
  const register = (registry: DeviceRegistry) =>
    registry.registerDevice({
      id: "imac-1",
      name: "David's iMac",
      type: DeviceType.MAC,
      platform: "macos",
      capabilities: ["get_active_application"],
      ...baseInput,
    });

  test("refreshes the profile an upgraded Agent re-reports", () => {
    const registry = new DeviceRegistry();
    register(registry);

    registry.updateRegistrationMetadata("imac-1", {
      name: "David's iMac",
      type: DeviceType.MAC,
      platform: "macos",
      agentVersion: "0.2.0",
      protocolVersion: "2",
      capabilities: ["get_active_application", "open_application", "click_element"],
    });

    const device = registry.getDevice("imac-1")!;
    expect(device.agentVersion).toBe("0.2.0");
    expect(device.protocolVersion).toBe("2");
    expect(device.capabilities).toEqual([
      "get_active_application",
      "open_application",
      "click_element",
    ]);
  });

  test("never lets a re-registration grant the device a role", () => {
    const registry = new DeviceRegistry();
    register(registry);
    registry.setRole("imac-1", DeviceRole.PRIMARY);

    // A device reconnecting asks for a role in every payload; honouring it
    // here would be a self-service promotion path around setRole.
    registry.updateRegistrationMetadata("imac-1", {
      name: "David's iMac",
      type: DeviceType.MAC,
      platform: "macos",
      requestedRole: DeviceRole.PRIMARY,
      ...baseInput,
    });

    expect(registry.getDevice("imac-1")?.role).toBe(DeviceRole.PRIMARY);
    expect(registry.getDevice("imac-1")?.requestedRole).toBe(DeviceRole.PRIMARY);
  });

  test("keeps an admin-assigned role when the device stops asking for one", () => {
    const registry = new DeviceRegistry();
    register(registry);
    registry.setRole("imac-1", DeviceRole.PRIMARY);

    registry.updateRegistrationMetadata("imac-1", {
      name: "David's iMac",
      type: DeviceType.MAC,
      platform: "macos",
      ...baseInput,
    });

    expect(registry.getDevice("imac-1")?.role).toBe(DeviceRole.PRIMARY);
    expect(registry.getDevice("imac-1")?.requestedRole).toBeNull();
  });

  test("throws for a device that was never registered", () => {
    const registry = new DeviceRegistry();

    expect(() =>
      registry.updateRegistrationMetadata("ghost", {
        name: "Ghost",
        type: DeviceType.MAC,
        platform: "macos",
        ...baseInput,
      })
    ).toThrow("Unknown device: ghost");
  });
});
