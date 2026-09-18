import { describe, test, expect, afterEach } from "bun:test";
import { writeFileSync, unlinkSync } from "node:fs";
import { EventBus } from "@/core/events/EventBus";
import { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import { PairingService } from "@/devices/pairing/PairingService";
import { DeviceConnectionManager } from "@/communication/websocket/DeviceConnectionManager";
import { JarvisWebSocketServer } from "@/communication/websocket/JarvisWebSocketServer";

let activeHandle: { stop: (force?: boolean) => void } | undefined;

afterEach(() => {
  activeHandle?.stop(true);
  activeHandle = undefined;
});

function setupServer(opts: { adminToken?: string; backupDbPaths?: string[] } = {}) {
  const eventBus = new EventBus();
  const server = new JarvisWebSocketServer({
    deviceRegistry: new DeviceRegistry(),
    deviceConnectionManager: new DeviceConnectionManager(eventBus),
    pairingService: new PairingService(),
    eventBus,
    adminToken: opts.adminToken,
    backupDbPaths: opts.backupDbPaths,
  });
  const handle = server.start(0);
  activeHandle = handle;
  return handle;
}

describe("GET /backup", () => {
  test("404s when no admin token is configured, regardless of headers sent", async () => {
    const handle = setupServer({});
    const response = await fetch(`http://localhost:${handle.port}/backup`, {
      headers: { "X-Jarvis-Admin-Token": "anything" },
    });
    expect(response.status).toBe(404);
  });

  test("401s with a missing or wrong admin token", async () => {
    const handle = setupServer({ adminToken: "secret-token" });

    const noHeader = await fetch(`http://localhost:${handle.port}/backup`);
    expect(noHeader.status).toBe(401);

    const wrongHeader = await fetch(`http://localhost:${handle.port}/backup`, {
      headers: { "X-Jarvis-Admin-Token": "wrong" },
    });
    expect(wrongHeader.status).toBe(401);
  });

  test("returns a gzip archive of the configured databases with a valid admin token", async () => {
    const dbPath = `/tmp/jarvis-backup-http-test-${crypto.randomUUID()}.sqlite`;
    writeFileSync(dbPath, "fake sqlite contents");

    try {
      const handle = setupServer({ adminToken: "secret-token", backupDbPaths: [dbPath] });
      const response = await fetch(`http://localhost:${handle.port}/backup`, {
        headers: { "X-Jarvis-Admin-Token": "secret-token" },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/gzip");
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(bytes.length).toBeGreaterThan(0);
    } finally {
      unlinkSync(dbPath);
    }
  });
});
