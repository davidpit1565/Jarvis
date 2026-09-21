import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  DeviceStatus,
  type Device,
  type DeviceRole,
  type DeviceStatus as DeviceStatusType,
  type RegisterDeviceInput,
} from "@/types/devices";

interface StoredDeviceRow {
  id: string;
  name: string;
  type: string;
  platform: string;
  role: string | null;
  requestedRole: string | null;
  agentVersion: string;
  protocolVersion: string;
  capabilities: string;
}

/**
 * Optionally SQLite-backed (pass a dbPath) so a device's identity and,
 * critically, its assigned role survive a server restart. Without this, a
 * MacBook/iMac holding a valid, still-working credential would reconnect
 * successfully after a restart but show up as a brand-new, role-less
 * device every time — silently losing "primary" and anything that depends
 * on it. `status`/`lastSeen` are deliberately NOT persisted: a device
 * reloaded from disk is "unknown" until it actually reconnects and proves
 * it, never assumed "online" just because it was online before a restart.
 */
export class DeviceRegistry {
  private devices: Map<string, Device> = new Map();
  private db: Database | null = null;

  constructor(dbPath?: string) {
    if (!dbPath || dbPath === ":memory:") return;

    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        platform TEXT NOT NULL,
        role TEXT,
        requested_role TEXT,
        agent_version TEXT NOT NULL,
        protocol_version TEXT NOT NULL,
        capabilities TEXT NOT NULL
      )
    `);

    const rows = this.db
      .query(
        `SELECT id, name, type, platform, role, requested_role as requestedRole, agent_version as agentVersion, protocol_version as protocolVersion, capabilities FROM devices`
      )
      .all() as StoredDeviceRow[];
    for (const row of rows) {
      this.devices.set(row.id, {
        id: row.id,
        name: row.name,
        type: row.type as Device["type"],
        platform: row.platform,
        role: (row.role as DeviceRole | null) ?? null,
        requestedRole: (row.requestedRole as DeviceRole | null) ?? null,
        agentVersion: row.agentVersion,
        protocolVersion: row.protocolVersion,
        status: DeviceStatus.UNKNOWN,
        capabilities: JSON.parse(row.capabilities) as string[],
        lastSeen: null,
        permissions: null,
      });
    }
  }

  private persist(device: Device): void {
    if (!this.db) return;
    this.db
      .query(
        `INSERT OR REPLACE INTO devices (id, name, type, platform, role, requested_role, agent_version, protocol_version, capabilities) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        device.id,
        device.name,
        device.type,
        device.platform,
        device.role,
        device.requestedRole,
        device.agentVersion,
        device.protocolVersion,
        JSON.stringify(device.capabilities)
      );
  }

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
      permissions: null,
    };
    this.devices.set(device.id, device);
    this.persist(device);
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
    // status/lastSeen are deliberately not persisted — see class docstring.
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
    this.persist(device);
    return device;
  }

  getPrimaryDevice(): Device | undefined {
    return this.listDevices().find((device) => device.role === "primary");
  }

  /**
   * Records a device's self-reported live permission/capability status
   * (from a `device.capabilities` message — see `protocol.ts`). Replaces
   * the whole map each time rather than merging, so a permission the
   * device stops reporting (e.g. a capability removed in a newer Agent
   * build) doesn't linger as stale state here. Not persisted — see the
   * `permissions` field's own doc comment on `Device`.
   */
  updateCapabilities(id: string, permissions: Record<string, string>): Device {
    const device = this.devices.get(id);
    if (!device) {
      throw new Error(`Unknown device: ${id}`);
    }
    device.permissions = permissions;
    return device;
  }

  close(): void {
    this.db?.close();
  }
}
