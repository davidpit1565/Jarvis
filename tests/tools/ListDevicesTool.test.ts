import { describe, test, expect } from "bun:test";
import { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import { createListDevicesTool } from "@/tools/devices/ListDevicesTool";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };

describe("LIST_DEVICES tool", () => {
  test("is READ", () => {
    const tool = createListDevicesTool(new DeviceRegistry());
    expect(tool.requiredPermission).toBe(PermissionLevel.READ);
  });

  test("returns an empty list when no devices are registered", async () => {
    const tool = createListDevicesTool(new DeviceRegistry());
    const result = await tool.execute({}, context);

    expect(result.success).toBe(true);
    expect((result.data as { devices: unknown[] }).devices).toEqual([]);
  });

  test("lists a registered device's id, name, type, platform, role, status, lastSeen", async () => {
    const deviceRegistry = new DeviceRegistry();
    deviceRegistry.registerDevice({
      id: "imac-1",
      name: "David's iMac",
      type: "mac",
      platform: "macos",
      agentVersion: "0.1.0",
      protocolVersion: "1",
    });
    deviceRegistry.setRole("imac-1", "primary");
    deviceRegistry.updateStatus("imac-1", "online");

    const tool = createListDevicesTool(deviceRegistry);
    const result = await tool.execute({}, context);

    expect(result.success).toBe(true);
    expect((result.data as { devices: unknown[] }).devices).toEqual([
      {
        id: "imac-1",
        name: "David's iMac",
        type: "mac",
        platform: "macos",
        role: "primary",
        status: "online",
        lastSeen: expect.any(String),
      },
    ]);
  });
});
