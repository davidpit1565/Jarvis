import {
  DeviceStatus,
  type Device,
  type DeviceRole,
  type DeviceStatus as DeviceStatusType,
  type RegisterDeviceInput,
} from "@/types/devices";

export class DeviceRegistry {
  private devices: Map<string, Device> = new Map();

  /**
   * Registers a device's metadata. `requestedRole` is recorded on the
   * device only as informational context (via capabilities/logs upstream);
   * the actual `role` always starts `null` — a device can never assign
   * itself a role, including "primary". Call setRole() explicitly to
   * approve one.
   */
  registerDevice(input: RegisterDeviceInput): Device {
    const device: Device = {
      id: input.id,
      name: input.name,
      type: input.type,
      platform: input.platform,
      role: null,
      requestedRole: input.requestedRole ?? null,
      agentVersion: input.agentVersion,
      protocolVersion: input.protocolVersion,
      status: DeviceStatus.UNKNOWN,
      capabilities: input.capabilities ?? [],
      lastSeen: null,
    };
    this.devices.set(device.id, device);
    return device;
  }

  getDevice(id: string): Device | undefined {
    return this.devices.get(id);
  }

  listDevices(): Device[] {
    return Array.from(this.devices.values());
  }

  updateStatus(id: string, status: DeviceStatusType): Device {
    const device = this.devices.get(id);
    if (!device) {
      throw new Error(`Unknown device: ${id}`);
    }
    device.status = status;
    device.lastSeen = new Date().toISOString();
    return device;
  }

  /**
   * The only way a device's role is ever assigned. This is a Core-side
   * administrative decision, never something a device can trigger on its
   * own by claiming a role in its registration payload.
   */
  setRole(id: string, role: DeviceRole): Device {
    const device = this.devices.get(id);
    if (!device) {
      throw new Error(`Unknown device: ${id}`);
    }

    if (role === "primary") {
      const existingPrimary = this.getPrimaryDevice();
      if (existingPrimary && existingPrimary.id !== id) {
        throw new Error(
          `Cannot assign primary role to "${id}": device "${existingPrimary.id}" is already primary`
        );
      }
    }

    device.role = role;
    return device;
  }

  getPrimaryDevice(): Device | undefined {
    return this.listDevices().find((device) => device.role === "primary");
  }
}
