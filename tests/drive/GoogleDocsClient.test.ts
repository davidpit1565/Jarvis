import { describe, test, expect, afterEach } from "bun:test";
import { CalendarTokenStore } from "@/calendar/CalendarTokenStore";
import { GoogleDriveClient } from "@/drive/GoogleDriveClient";
import { GoogleDocsClient } from "@/drive/GoogleDocsClient";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function makeClients() {
  const tokenStore = new CalendarTokenStore(":memory:");
  tokenStore.save("me@example.com", { refreshToken: "r1", accessToken: "valid", accessTokenExpiresAt: Date.now() + 3_600_000 });
  const driveClient = new GoogleDriveClient("client-id", "client-secret", tokenStore);
  return { docsClient: new GoogleDocsClient(driveClient) };
}

function routedFetch(opts?: { batchBody?: { requests: Record<string, unknown>[] } }) {
  return (async (url: string, init?: RequestInit) => {
    if (url.includes("docs.googleapis.com/v1/documents") && !url.includes(":batchUpdate")) {
      return new Response(JSON.stringify({ documentId: "doc-1" }), { status: 200 });
    }
    if (url.includes(":batchUpdate")) {
      if (opts) opts.batchBody = JSON.parse(init!.body as string);
      return new Response(JSON.stringify({}), { status: 200 });
    }
    if (url.includes("/drive/v3/files/doc-1")) {
      return new Response(
        JSON.stringify({ id: "doc-1", name: "Packing list", webViewLink: "https://docs.google.com/document/d/doc-1", mimeType: "application/vnd.google-apps.document" }),
        { status: 200 }
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

describe("GoogleDocsClient.createChecklist", () => {
  test("creates a document and populates it with a real checkbox list", async () => {
    const opts: { batchBody?: { requests: Record<string, unknown>[] } } = {};
    global.fetch = routedFetch(opts);

    const { docsClient } = makeClients();
    const { file, itemCount } = await docsClient.createChecklist("Packing list", ["Passport", "Charger", "Toothbrush"]);

    expect(itemCount).toBe(3);
    expect(file.webViewLink).toBe("https://docs.google.com/document/d/doc-1");

    const requests = opts.batchBody!.requests;
    const insert = requests[0] as { insertText: { location: { index: number }; text: string } };
    expect(insert.insertText.location.index).toBe(1);
    expect(insert.insertText.text).toBe("Passport\nCharger\nToothbrush\n");

    const bullets = requests[1] as { createParagraphBullets: { range: { startIndex: number; endIndex: number }; bulletPreset: string } };
    expect(bullets.createParagraphBullets.bulletPreset).toBe("BULLET_CHECKBOX");
    expect(bullets.createParagraphBullets.range.startIndex).toBe(1);
    expect(bullets.createParagraphBullets.range.endIndex).toBe(1 + insert.insertText.text.length);
  });

  test("rejects an empty item list", async () => {
    const { docsClient } = makeClients();
    await expect(docsClient.createChecklist("Empty", [])).rejects.toThrow(/at least one item/i);
  });

  test("throws on a creation failure", async () => {
    global.fetch = (async () => new Response("bad request", { status: 400 })) as unknown as typeof fetch;
    const { docsClient } = makeClients();
    await expect(docsClient.createChecklist("Title", ["Item"])).rejects.toThrow(/400/);
  });

  test("throws on a batchUpdate (population) failure", async () => {
    global.fetch = (async (url: string) => {
      if (url.includes(":batchUpdate")) return new Response("boom", { status: 500 });
      if (url.includes("documents")) return new Response(JSON.stringify({ documentId: "doc-1" }), { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const { docsClient } = makeClients();
    await expect(docsClient.createChecklist("Title", ["Item"])).rejects.toThrow(/500/);
  });
});
