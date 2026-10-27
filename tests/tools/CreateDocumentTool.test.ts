import { describe, test, expect, afterEach } from "bun:test";
import { CalendarTokenStore } from "@/calendar/CalendarTokenStore";
import { GoogleDriveClient } from "@/drive/GoogleDriveClient";
import { GoogleDocsClient } from "@/drive/GoogleDocsClient";
import { createCreateDocumentTool } from "@/tools/drive/CreateDocumentTool";
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
      return new Response(JSON.stringify({ id: "doc-1", name: "Report", webViewLink: "https://docs.google.com/document/d/doc-1", mimeType: "x" }), { status: 200 });
    }
    if (url.includes("documents")) return new Response(JSON.stringify({ documentId: "doc-1" }), { status: 200 });
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

describe("CREATE_DOCUMENT tool", () => {
  test("is SAFE_ACTION", () => {
    const tool = createCreateDocumentTool(makeDocsClient());
    expect(tool.requiredPermission).toBe(PermissionLevel.SAFE_ACTION);
  });

  test("creates a document on success and returns its webViewLink", async () => {
    global.fetch = okFetch();
    const tool = createCreateDocumentTool(makeDocsClient());
    const result = await tool.execute(
      {
        title: "Report",
        sections: [
          { heading: "Overview", paragraphs: ["Here is what happened."] },
          { heading: "Next steps", bullets: ["Do thing one", "Do thing two"] },
        ],
      },
      context
    );

    expect(result.success).toBe(true);
    expect((result.data as { file: { webViewLink: string } }).file.webViewLink).toBe("https://docs.google.com/document/d/doc-1");
    expect((result.data as { blockCount: number }).blockCount).toBe(4);
  });

  test("accepts a section with only paragraphs and no heading", async () => {
    global.fetch = okFetch();
    const tool = createCreateDocumentTool(makeDocsClient());
    const result = await tool.execute({ title: "Notes", sections: [{ paragraphs: ["Just prose, no heading."] }] }, context);
    expect(result.success).toBe(true);
  });

  test("rejects a missing title", async () => {
    const tool = createCreateDocumentTool(makeDocsClient());
    const result = await tool.execute({ title: "", sections: [{ paragraphs: ["x"] }] }, context);
    expect(result.success).toBe(false);
  });

  test("rejects a non-array sections field", async () => {
    const tool = createCreateDocumentTool(makeDocsClient());
    const result = await tool.execute({ title: "Doc", sections: "not an array" } as unknown as Parameters<typeof tool.execute>[0], context);
    expect(result.success).toBe(false);
  });

  test("rejects an empty sections array", async () => {
    const tool = createCreateDocumentTool(makeDocsClient());
    const result = await tool.execute({ title: "Doc", sections: [] }, context);
    expect(result.success).toBe(false);
  });

  test("rejects a section with a non-string heading", async () => {
    const tool = createCreateDocumentTool(makeDocsClient());
    const result = await tool.execute({ title: "Doc", sections: [{ heading: 5 }] } as unknown as Parameters<typeof tool.execute>[0], context);
    expect(result.success).toBe(false);
  });

  test("returns a failure result (not a throw) on an API error", async () => {
    global.fetch = (async () => new Response("bad request", { status: 400 })) as unknown as typeof fetch;
    const tool = createCreateDocumentTool(makeDocsClient());
    const result = await tool.execute({ title: "Doc", sections: [{ paragraphs: ["x"] }] }, context);
    expect(result.success).toBe(false);
  });
});
