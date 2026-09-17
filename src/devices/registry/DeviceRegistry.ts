import { DeviceStatus, type Device, type DeviceStatus as DeviceStatusType, type RegisterDeviceInput } from "@/types/devices";

export class DeviceRegistry {
  private devices: Map<string, Device> = new Map();

  registerDevice(input: RegisterDeviceInput): Device {
    const device: Device = {
      id: input.id,
      name: input.name,
      type: input.type,
      platform: input.platform,
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
}
