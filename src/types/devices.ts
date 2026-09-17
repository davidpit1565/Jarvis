export const DeviceType = {
  MAC: "mac",
  IPHONE: "iphone",
} as const;

export type DeviceType = (typeof DeviceType)[keyof typeof DeviceType];

export const DeviceStatus = {
  OFFLINE: "offline",
  ONLINE: "online",
  UNKNOWN: "unknown",
} as const;

export type DeviceStatus = (typeof DeviceStatus)[keyof typeof DeviceStatus];

export interface Device {
  id: string;
  name: string;
  type: DeviceType;
  platform: string;
  status: DeviceStatus;
  capabilities: string[];
  lastSeen: string | null;
}

export interface RegisterDeviceInput {
  id: string;
  name: string;
  type: DeviceType;
  platform: string;
  capabilities?: string[];
}
