import { describe, test, expect, afterEach } from "bun:test";
import { CalendarTokenStore } from "@/calendar/CalendarTokenStore";
import { GoogleDriveClient } from "@/drive/GoogleDriveClient";
import { GoogleDocsClient } from "@/drive/GoogleDocsClient";
import { createCreateChecklistTool } from "@/tools/drive/CreateChecklistTool";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function makeDocsClient() {
  const tokenStore = new CalendarTokenStore(":memory:");
  tokenStore.save("me@example.com", { refreshToken: "r1", accessToken: "a1", accessTokenExpiresAt: Date.now() + 3_600_000 });
  return new GoogleDocsClient(new GoogleDriveClient("id", "secret", tokenStore));
}

function okFetch() {
  return (async (url: string) => {
    if (url.includes(":batchUpdate")) return new Response(JSON.stringify({}), { status: 200 });
    if (url.includes("/drive/v3/files/")) {
      return new Response(JSON.stringify({ id: "doc-1", name: "Checklist", webViewLink: "https://docs.google.com/document/d/doc-1", mimeType: "x" }), { status: 200 });
    }
    if (url.includes("documents")) return new Response(JSON.stringify({ documentId: "doc-1" }), { status: 200 });
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

describe("CREATE_CHECKLIST tool", () => {
  test("is SAFE_ACTION", () => {
    const tool = createCreateChecklistTool(makeDocsClient());
    expect(tool.requiredPermission).toBe(PermissionLevel.SAFE_ACTION);
  });

  test("creates a checklist on success and returns its webViewLink", async () => {
    global.fetch = okFetch();
    const tool = createCreateChecklistTool(makeDocsClient());
    const result = await tool.execute({ title: "Packing", items: ["Passport", "Charger"] }, context);

    expect(result.success).toBe(true);
    expect((result.data as { file: { webViewLink: string } }).file.webViewLink).toBe("https://docs.google.com/document/d/doc-1");
  });

  test("rejects a missing title", async () => {
    const tool = createCreateChecklistTool(makeDocsClient());
    const result = await tool.execute({ title: "", items: ["Item"] }, context);
    expect(result.success).toBe(false);
  });

  test("rejects a non-array items field", async () => {
    const tool = createCreateChecklistTool(makeDocsClient());
    const result = await tool.execute({ title: "List", items: "not an array" } as unknown as { title: string; items: string[] }, context);
    expect(result.success).toBe(false);
  });

  test("rejects an empty items array", async () => {
    const tool = createCreateChecklistTool(makeDocsClient());
    const result = await tool.execute({ title: "List", items: [] }, context);
    expect(result.success).toBe(false);
  });

  test("returns a failure result (not a throw) on an API error", async () => {
    global.fetch = (async () => new Response("bad request", { status: 400 })) as unknown as typeof fetch;
    const tool = createCreateChecklistTool(makeDocsClient());
    const result = await tool.execute({ title: "List", items: ["Item"] }, context);
    expect(result.success).toBe(false);
  });
});
