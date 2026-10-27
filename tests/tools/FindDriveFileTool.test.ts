import { describe, test, expect, afterEach } from "bun:test";
import { CalendarTokenStore } from "@/calendar/CalendarTokenStore";
import { GoogleDriveClient } from "@/drive/GoogleDriveClient";
import { createFindDriveFileTool } from "@/tools/drive/FindDriveFileTool";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function makeDriveClient() {
  const tokenStore = new CalendarTokenStore(":memory:");
  tokenStore.save("me@example.com", { refreshToken: "r1", accessToken: "a1", accessTokenExpiresAt: Date.now() + 3_600_000 });
  return new GoogleDriveClient("id", "secret", tokenStore);
}

describe("FIND_DRIVE_FILE tool", () => {
  test("is READ", () => {
    const tool = createFindDriveFileTool(makeDriveClient());
    expect(tool.requiredPermission).toBe(PermissionLevel.READ);
  });

  test("finds matching files on success", async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ files: [{ id: "f1", name: "BFA checklist", mimeType: "application/vnd.google-apps.document" }] }), { status: 200 })) as unknown as typeof fetch;

    const tool = createFindDriveFileTool(makeDriveClient());
    const result = await tool.execute({ name: "BFA" }, context);

    expect(result.success).toBe(true);
    expect((result.data as { files: unknown[] }).files).toHaveLength(1);
  });

  test("rejects a missing name", async () => {
    const tool = createFindDriveFileTool(makeDriveClient());
    const result = await tool.execute({ name: "" }, context);
    expect(result.success).toBe(false);
  });

  test("rejects a non-positive maxResults", async () => {
    const tool = createFindDriveFileTool(makeDriveClient());
    const result = await tool.execute({ name: "deck", maxResults: 0 }, context);
    expect(result.success).toBe(false);
  });

  test("returns a failure result (not a throw) on an API error", async () => {
    global.fetch = (async () => new Response("bad request", { status: 400 })) as unknown as typeof fetch;
    const tool = createFindDriveFileTool(makeDriveClient());
    const result = await tool.execute({ name: "deck" }, context);
    expect(result.success).toBe(false);
  });
});
