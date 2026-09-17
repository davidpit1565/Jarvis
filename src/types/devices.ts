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

/**
 * A device's role in the JARVIS system. Exactly one device should hold
 * "primary" at a time (the iMac, initially) — Core assigns this, a device
 * can only *request* it during registration.
 */
export const DeviceRole = {
  PRIMARY: "primary",
  SECONDARY: "secondary",
  MOBILE: "mobile",
} as const;

export type DeviceRole = (typeof DeviceRole)[keyof typeof DeviceRole];

export interface Device {
  id: string;
  name: string;
  type: DeviceType;
  platform: string;
  /** Assigned by Core. Null until Core explicitly assigns a role. */
  role: DeviceRole | null;
  /** The role this device asked for at registration, kept for reference — never authoritative. */
  requestedRole: DeviceRole | null;
  agentVersion: string;
  protocolVersion: string;
  status: DeviceStatus;
  capabilities: string[];
  lastSeen: string | null;
}

export interface RegisterDeviceInput {
  id: string;
  name: string;
  type: DeviceType;
  platform: string;
  agentVersion: string;
  protocolVersion: string;
  capabilities?: string[];
  /**
   * The role the device is asking for (e.g. an iMac agent may request
   * "primary"). This is a request only — Core decides the actual role via
   * DeviceRegistry.setRole(). Registration never grants this automatically.
   */
  requestedRole?: DeviceRole;
}
