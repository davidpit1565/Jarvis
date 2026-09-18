import { describe, test, expect, afterEach } from "bun:test";
import { StudioClient } from "@/studio/StudioClient";
import { createListReelsTool } from "@/tools/studio/ListReelsTool";
import { createGetInstagramStatsTool } from "@/tools/studio/GetInstagramStatsTool";
import { createPublishReelTool } from "@/tools/studio/PublishReelTool";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function makeClient(): StudioClient {
  return new StudioClient("https://studio.example.com", "secret-1");
}

describe("LIST_REELS tool", () => {
  test("is READ", () => {
    expect(createListReelsTool(makeClient()).requiredPermission).toBe(PermissionLevel.READ);
  });

  test("returns the reels list", async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ ok: true, reels: [{ file: "ep1.mp4" }] }), { status: 200 })) as unknown as typeof fetch;

    const result = await createListReelsTool(makeClient()).execute({}, context);
    expect(result.success).toBe(true);
    expect((result.data as { reels: unknown[] }).reels).toHaveLength(1);
  });

  test("returns a failure result (not a throw) on an error", async () => {
    global.fetch = (async () => new Response("locked", { status: 401 })) as unknown as typeof fetch;
    const result = await createListReelsTool(makeClient()).execute({}, context);
    expect(result.success).toBe(false);
  });
});

describe("GET_INSTAGRAM_STATS tool", () => {
  test("is READ", () => {
    expect(createGetInstagramStatsTool(makeClient()).requiredPermission).toBe(PermissionLevel.READ);
  });

  test("returns the stats", async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ connected: true, username: "x", followers: 1, mediaCount: 1, media: [] }), {
        status: 200,
      })) as unknown as typeof fetch;

    const result = await createGetInstagramStatsTool(makeClient()).execute({}, context);
    expect(result.success).toBe(true);
  });
});

describe("PUBLISH_REEL tool", () => {
  test("is DANGEROUS", () => {
    expect(createPublishReelTool(makeClient()).requiredPermission).toBe(PermissionLevel.DANGEROUS);
  });

  test("rejects a missing file", async () => {
    const result = await createPublishReelTool(makeClient()).execute({ file: "" }, context);
    expect(result.success).toBe(false);
  });

  test("publishes successfully and returns the studio's result", async () => {
    let capturedBody: unknown;
    global.fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body;
      return new Response(JSON.stringify({ ok: true, reel: { ok: true } }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await createPublishReelTool(makeClient()).execute({ file: "ep1.mp4", caption: "hi" }, context);
    expect(result.success).toBe(true);
    expect(JSON.parse(capturedBody as string)).toEqual({ file: "ep1.mp4", caption: "hi" });
  });

  test("returns a failure result when the studio reports ok: false", async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ ok: false, reason: "Instagram rejected the upload" }), { status: 200 })) as unknown as typeof fetch;

    const result = await createPublishReelTool(makeClient()).execute({ file: "ep1.mp4" }, context);
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toBe("Instagram rejected the upload");
  });
});
