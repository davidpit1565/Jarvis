import { describe, test, expect } from "bun:test";
import { writeFileSync, unlinkSync } from "node:fs";
import { createBackupArchive } from "@/backup/createBackupArchive";

describe("createBackupArchive", () => {
  test("returns 404 when none of the given paths exist", async () => {
    const response = createBackupArchive(["/tmp/jarvis-backup-test-does-not-exist.sqlite"]);
    expect(response.status).toBe(404);
  });

  test("streams a non-empty gzip archive when a file exists", async () => {
    const path = `/tmp/jarvis-backup-test-${crypto.randomUUID()}.sqlite`;
    writeFileSync(path, "fake sqlite contents");

    try {
      const response = createBackupArchive([path, "/tmp/jarvis-backup-test-missing.sqlite"]);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/gzip");
      expect(response.headers.get("Content-Disposition")).toContain("jarvis-backup-");

      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(bytes.length).toBeGreaterThan(0);
      // gzip magic number
      expect(bytes[0]).toBe(0x1f);
      expect(bytes[1]).toBe(0x8b);
    } finally {
      unlinkSync(path);
    }
  });
});
