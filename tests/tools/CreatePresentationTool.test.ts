import { describe, test, expect, afterEach } from "bun:test";
import { CalendarTokenStore } from "@/calendar/CalendarTokenStore";
import { GoogleDriveClient } from "@/drive/GoogleDriveClient";
import { GoogleSlidesClient } from "@/drive/GoogleSlidesClient";
import { createCreatePresentationTool } from "@/tools/drive/CreatePresentationTool";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function makeSlidesClient() {
  const tokenStore = new CalendarTokenStore(":memory:");
  tokenStore.save("me@example.com", { refreshToken: "r1", accessToken: "a1", accessTokenExpiresAt: Date.now() + 3_600_000 });
  return new GoogleSlidesClient(new GoogleDriveClient("id", "secret", tokenStore));
}

function okFetch() {
  return (async (url: string, init?: RequestInit) => {
    if (url.includes(":batchUpdate")) return new Response(JSON.stringify({}), { status: 200 });
    if (url.includes("/drive/v3/files/")) {
      return new Response(JSON.stringify({ id: "pres-1", name: "Deck", webViewLink: "https://docs.google.com/presentation/d/pres-1", mimeType: "x" }), { status: 200 });
    }
    if ((init?.method ?? "GET") === "POST") return new Response(JSON.stringify({ presentationId: "pres-1", slides: [{ objectId: "s0" }] }), { status: 200 });
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

const validInput = { title: "My Deck", slides: [{ title: "Intro", bullets: ["Point A", "Point B"] }] };

describe("CREATE_PRESENTATION tool", () => {
  test("is SAFE_ACTION", () => {
    const tool = createCreatePresentationTool(makeSlidesClient());
    expect(tool.requiredPermission).toBe(PermissionLevel.SAFE_ACTION);
  });

  test("creates a presentation on success and returns its webViewLink", async () => {
    global.fetch = okFetch();
    const tool = createCreatePresentationTool(makeSlidesClient());
    const result = await tool.execute(validInput, context);

    expect(result.success).toBe(true);
    expect((result.data as { file: { webViewLink: string } }).file.webViewLink).toBe("https://docs.google.com/presentation/d/pres-1");
  });

  test("rejects a missing title", async () => {
    const tool = createCreatePresentationTool(makeSlidesClient());
    const result = await tool.execute({ title: "", slides: validInput.slides }, context);
    expect(result.success).toBe(false);
  });

  test("rejects slides that aren't the expected shape", async () => {
    const tool = createCreatePresentationTool(makeSlidesClient());
    const result = await tool.execute(
      { title: "Deck", slides: [{ title: "Intro" }] } as unknown as typeof validInput,
      context
    );
    expect(result.success).toBe(false);
  });

  test("rejects an empty slides array", async () => {
    const tool = createCreatePresentationTool(makeSlidesClient());
    const result = await tool.execute({ title: "Deck", slides: [] }, context);
    expect(result.success).toBe(false);
  });

  test("returns a failure result (not a throw) on an API error", async () => {
    global.fetch = (async () => new Response("bad request", { status: 400 })) as unknown as typeof fetch;
    const tool = createCreatePresentationTool(makeSlidesClient());
    const result = await tool.execute(validInput, context);
    expect(result.success).toBe(false);
  });
});
