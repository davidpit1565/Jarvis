import { describe, test, expect, afterEach } from "bun:test";
import { CalendarTokenStore } from "@/calendar/CalendarTokenStore";
import { GoogleDriveClient } from "@/drive/GoogleDriveClient";
import { GoogleSlidesClient } from "@/drive/GoogleSlidesClient";
import type { PresentationOutline } from "@/types/drive";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function makeClients() {
  const tokenStore = new CalendarTokenStore(":memory:");
  tokenStore.save("me@example.com", { refreshToken: "r1", accessToken: "valid", accessTokenExpiresAt: Date.now() + 3_600_000 });
  const driveClient = new GoogleDriveClient("client-id", "client-secret", tokenStore);
  return { slidesClient: new GoogleSlidesClient(driveClient), tokenStore };
}

const outline: PresentationOutline = {
  title: "Q1 Plan",
  slides: [
    { title: "Goals", bullets: ["Ship feature X", "Hit metric Y"] },
    { title: "Risks", bullets: ["Timeline"] },
  ],
};

/** Routes a mocked fetch between the Slides create/batchUpdate endpoints and the Drive getFile lookup. */
function routedFetch(opts?: { batchRequests?: Record<string, unknown>[][] }) {
  return (async (url: string, init?: RequestInit) => {
    if (url.includes("slides.googleapis.com/v1/presentations") && !url.includes(":batchUpdate") && (init?.method ?? "GET") === "POST") {
      return new Response(JSON.stringify({ presentationId: "pres-1", slides: [{ objectId: "default-slide" }] }), { status: 200 });
    }
    if (url.includes(":batchUpdate")) {
      const body = JSON.parse(init!.body as string) as { requests: Record<string, unknown>[] };
      opts?.batchRequests?.push(body.requests);
      return new Response(JSON.stringify({ replies: [] }), { status: 200 });
    }
    if (url.includes("/drive/v3/files/pres-1")) {
      return new Response(
        JSON.stringify({ id: "pres-1", name: "Q1 Plan", webViewLink: "https://docs.google.com/presentation/d/pres-1", mimeType: "application/vnd.google-apps.presentation" }),
        { status: 200 }
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

describe("GoogleSlidesClient.createPresentation", () => {
  test("creates the presentation, deletes the default slide, and populates every outline slide", async () => {
    const batches: Record<string, unknown>[][] = [];
    global.fetch = routedFetch({ batchRequests: batches });

    const { slidesClient } = makeClients();
    const { file, slideCount } = await slidesClient.createPresentation(outline);

    expect(slideCount).toBe(2);
    expect(file.webViewLink).toBe("https://docs.google.com/presentation/d/pres-1");

    const requests = batches[0]!;
    expect(requests[0]).toEqual({ deleteObject: { objectId: "default-slide" } });

    const createSlideRequests = requests.filter((r) => "createSlide" in r);
    expect(createSlideRequests).toHaveLength(3); // title slide + 2 content slides

    const titleSlide = createSlideRequests[0] as { createSlide: { slideLayoutReference: { predefinedLayout: string } } };
    expect(titleSlide.createSlide.slideLayoutReference.predefinedLayout).toBe("TITLE");

    const contentSlide = createSlideRequests[1] as { createSlide: { slideLayoutReference: { predefinedLayout: string } } };
    expect(contentSlide.createSlide.slideLayoutReference.predefinedLayout).toBe("TITLE_AND_BODY");

    const bulletRequests = requests.filter((r) => "createParagraphBullets" in r) as Array<{
      createParagraphBullets: { textRange: { type: string }; bulletPreset: string };
    }>;
    expect(bulletRequests).toHaveLength(2);
    expect(bulletRequests[0]!.createParagraphBullets.textRange).toEqual({ type: "ALL" });
    expect(bulletRequests[0]!.createParagraphBullets.bulletPreset).toBe("BULLET_DISC_CIRCLE_SQUARE");

    const bodyInsert = requests.find(
      (r) => "insertText" in r && (r as { insertText: { text: string } }).insertText.text.includes("Ship feature X")
    ) as { insertText: { text: string } };
    expect(bodyInsert.insertText.text).toBe("Ship feature X\nHit metric Y");
  });

  test("rejects an outline with no slides", async () => {
    const { slidesClient } = makeClients();
    await expect(slidesClient.createPresentation({ title: "Empty", slides: [] })).rejects.toThrow(/at least one slide/i);
  });

  test("throws on a creation failure", async () => {
    global.fetch = (async () => new Response("bad request", { status: 400 })) as unknown as typeof fetch;
    const { slidesClient } = makeClients();
    await expect(slidesClient.createPresentation(outline)).rejects.toThrow(/400/);
  });

  test("throws on a batchUpdate (population) failure", async () => {
    global.fetch = (async (url: string, init?: RequestInit) => {
      if (url.includes(":batchUpdate")) return new Response("boom", { status: 500 });
      if ((init?.method ?? "GET") === "POST") return new Response(JSON.stringify({ presentationId: "pres-1", slides: [{ objectId: "s0" }] }), { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const { slidesClient } = makeClients();
    await expect(slidesClient.createPresentation(outline)).rejects.toThrow(/500/);
  });
});
