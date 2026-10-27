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

describe("GoogleDocsClient.createDocument", () => {
  test("rejects an empty section list", async () => {
    const { docsClient } = makeClients();
    await expect(docsClient.createDocument("Empty", [])).rejects.toThrow(/at least one section/i);
  });

  test("rejects sections that are all entirely empty", async () => {
    const { docsClient } = makeClients();
    await expect(docsClient.createDocument("Empty", [{}, { heading: "" }])).rejects.toThrow(/heading, paragraph, or bullet/i);
  });

  test("throws on a creation failure", async () => {
    global.fetch = (async () => new Response("bad request", { status: 400 })) as unknown as typeof fetch;
    const { docsClient } = makeClients();
    await expect(docsClient.createDocument("Title", [{ paragraphs: ["hello"] }])).rejects.toThrow(/400/);
  });

  test("throws on a batchUpdate (population) failure", async () => {
    global.fetch = (async (url: string) => {
      if (url.includes(":batchUpdate")) return new Response("boom", { status: 500 });
      if (url.includes("documents")) return new Response(JSON.stringify({ documentId: "doc-1" }), { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const { docsClient } = makeClients();
    await expect(docsClient.createDocument("Title", [{ paragraphs: ["hello"] }])).rejects.toThrow(/500/);
  });

  test("computes correct insertion indices and style ranges for a multi-section document", async () => {
    const opts: { batchBody?: { requests: Record<string, unknown>[] } } = {};
    global.fetch = routedFetch(opts);

    const { docsClient } = makeClients();
    const sections = [
      {
        heading: "Overview",
        paragraphs: ["This is the first paragraph.", "This is the second paragraph."],
      },
      {
        heading: "Next steps",
        bullets: ["Do thing one", "Do thing two"],
      },
    ];
    const { file, blockCount } = await docsClient.createDocument("Report", sections);

    // heading1, para1, para2, heading2, bullets (bullets collapse into one block) = 5 blocks
    expect(blockCount).toBe(5);
    expect(file.webViewLink).toBe("https://docs.google.com/document/d/doc-1");

    const requests = opts.batchBody!.requests;

    // Block texts, each followed by "\n", concatenated in document order:
    // "Overview\n" + "This is the first paragraph.\n" + "This is the second paragraph.\n"
    // + "Next steps\n" + "Do thing one\nDo thing two\n"
    const block1 = "Overview\n";
    const block2 = "This is the first paragraph.\n";
    const block3 = "This is the second paragraph.\n";
    const block4 = "Next steps\n";
    const block5 = "Do thing one\nDo thing two\n";
    const fullText = block1 + block2 + block3 + block4 + block5;

    const insert = requests[0] as { insertText: { location: { index: number }; text: string } };
    expect(insert.insertText.location.index).toBe(1);
    expect(insert.insertText.text).toBe(fullText);

    // Heading 1: "Overview" at [1, 1+len(block1))
    const heading1 = requests[1] as { updateParagraphStyle: { range: { startIndex: number; endIndex: number }; paragraphStyle: { namedStyleType: string }; fields: string } };
    expect(heading1.updateParagraphStyle.range.startIndex).toBe(1);
    expect(heading1.updateParagraphStyle.range.endIndex).toBe(1 + block1.length);
    expect(heading1.updateParagraphStyle.paragraphStyle.namedStyleType).toBe("HEADING_1");
    expect(heading1.updateParagraphStyle.fields).toBe("namedStyleType");

    // Heading 2: "Next steps" starts after block1+block2+block3
    const headingStart = 1 + block1.length + block2.length + block3.length;
    const heading2 = requests[2] as { updateParagraphStyle: { range: { startIndex: number; endIndex: number } } };
    expect(heading2.updateParagraphStyle.range.startIndex).toBe(headingStart);
    expect(heading2.updateParagraphStyle.range.endIndex).toBe(headingStart + block4.length);

    // Bullets: starts after heading2
    const bulletsStart = headingStart + block4.length;
    const bullets = requests[3] as { createParagraphBullets: { range: { startIndex: number; endIndex: number }; bulletPreset: string } };
    expect(bullets.createParagraphBullets.range.startIndex).toBe(bulletsStart);
    expect(bullets.createParagraphBullets.range.endIndex).toBe(bulletsStart + block5.length);
    expect(bullets.createParagraphBullets.bulletPreset).toBe("BULLET_DISC_CIRCLE_SQUARE");

    // insertText + 2 heading style requests + 1 bullet request = 4; the two
    // plain paragraphs get no style request since NORMAL_TEXT is already
    // the default.
    expect(requests.length).toBe(4);
  });

  test("rejects a document over the block cap", async () => {
    const { docsClient } = makeClients();
    const hugeParagraphs = Array.from({ length: 301 }, (_, i) => `Paragraph ${i}`);
    await expect(docsClient.createDocument("Huge", [{ paragraphs: hugeParagraphs }])).rejects.toThrow(/at most 300/i);
  });

  test("rejects a document over the section cap", async () => {
    const { docsClient } = makeClients();
    const hugeSections = Array.from({ length: 51 }, (_, i) => ({ paragraphs: [`Section ${i}`] }));
    await expect(docsClient.createDocument("Huge", hugeSections)).rejects.toThrow(/at most 50 sections/i);
  });
});
