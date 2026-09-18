import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { DeviceRegistry } from "@/devices/registry/DeviceRegistry";

/**
 * Lets Claude answer "what devices are connected" / "is my Mac online" —
 * directly useful for the cross-device story (a request on one device
 * acting on another) since Claude needs to know what's actually paired
 * and online before it can decide where to run a device tool. Read-only;
 * never exposes anything about a device beyond what's already visible in
 * its own registration (name, type, platform, role, online status).
 */
export function createListDevicesTool(deviceRegistry: DeviceRegistry): LocalTool {
  return {
    id: "LIST_DEVICES",
    name: "list_devices",
    description:
      "Lists every paired device (Mac, iPhone, etc.), its role (primary/secondary/mobile), and whether it's " +
      'currently online. Use this to answer "what devices are connected" or to check whether a specific ' +
      "device is reachable before asking it to run something. Read-only.",
    inputSchema: { type: "object", properties: {} },
    requiredPermission: PermissionLevel.READ,
    target: "local",

    async execute() {
      const devices = deviceRegistry.listDevices().map((device) => ({
        id: device.id,
        name: device.name,
        type: device.type,
        platform: device.platform,
        role: device.role,
        status: device.status,
        lastSeen: device.lastSeen,
      }));
      return { success: true, data: { devices } };
    },
  };
}
