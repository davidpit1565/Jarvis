import type { GoogleDriveClient } from "@/drive/GoogleDriveClient";
import type { DriveFile } from "@/types/drive";
import type { PresentationOutline } from "@/types/drive";
import { fetchWithRetry } from "@/core/net/fetchWithRetry";
import { apiError } from "@/core/net/apiError";

const SLIDES_PRESENTATIONS_URL = "https://slides.googleapis.com/v1/presentations";

// A presentation the Slides API lets through with no slides at all would
// be a useless, confusing result ("I made your presentation" for an empty
// deck) — reject it before ever calling the API.
const MAX_SLIDES = 30;

interface RawPresentation {
  presentationId: string;
  slides?: Array<{ objectId: string }>;
}

/**
 * Google Slides access via raw fetch calls to the Slides v1 REST API — same
 * no-SDK style as GoogleCalendarClient/GmailClient/GoogleDriveClient.
 * Implements the templating layer the CREATE_PRESENTATION tool depends on:
 * the model only ever produces a simple `PresentationOutline`
 * (`{title, slides: [{title, bullets}]}`); THIS class turns that into the
 * actual Slides API `batchUpdate` requests (`createSlide`, `insertText`,
 * `createParagraphBullets`) — the model never writes raw Slides API JSON.
 *
 * Request shapes below are verified against Google's own current Slides
 * API documentation and samples (developers.google.com/workspace/slides/api/
 * samples/{slides,elements}), not guessed:
 *   - `createSlide` takes `objectId` (caller-chosen, so later requests in
 *     the SAME batch can reference it before the API ever responds),
 *     `insertionIndex`, `slideLayoutReference.predefinedLayout`, and
 *     `placeholderIdMappings` to pin the new slide's TITLE/BODY
 *     placeholders to caller-chosen object ids too.
 *   - `insertText` into an (empty) placeholder/text box takes `objectId` +
 *     `text` + `insertionIndex: 0`.
 *   - `createParagraphBullets` takes `objectId` + `bulletPreset` +
 *     `textRange: {type: "ALL"}` (NOT a startIndex/endIndex range — that's
 *     the Docs API's shape, not Slides').
 * All of this goes in ONE `batchUpdate` call: batchUpdate requests execute
 * in the order given, so a `createSlide` naming its own placeholder ids can
 * be immediately followed by `insertText`/`createParagraphBullets` requests
 * targeting those same ids without a round trip in between.
 *
 * `presentations.create` always returns a presentation with one default
 * slide using the built-in TITLE layout — rather than guessing at that
 * default slide's own (API-generated) placeholder object ids, this deletes
 * it and creates every slide (including the title slide) itself with
 * known ids, which is simpler and more robust than inspecting the create
 * response's `pageElements` for a placeholder's `objectId`.
 */
export class GoogleSlidesClient {
  constructor(private readonly driveClient: GoogleDriveClient) {}

  async createPresentation(
    outline: PresentationOutline,
    account?: string
  ): Promise<{ file: DriveFile; slideCount: number }> {
    if (outline.slides.length === 0) {
      throw new Error("A presentation needs at least one slide.");
    }
    if (outline.slides.length > MAX_SLIDES) {
      throw new Error(`A presentation can have at most ${MAX_SLIDES} slides (got ${outline.slides.length}).`);
    }

    const resolvedAccount = this.driveClient.resolveAccount(account);
    const accessToken = await this.driveClient.getValidAccessToken(resolvedAccount);

    const createResponse = await fetchWithRetry(SLIDES_PRESENTATIONS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: outline.title }),
    });
    if (!createResponse.ok) {
      throw await apiError("Google Slides presentation creation failed", createResponse);
    }
    const presentation = (await createResponse.json()) as RawPresentation;
    const presentationId = presentation.presentationId;
    const defaultSlideId = presentation.slides?.[0]?.objectId;

    const requests: Record<string, unknown>[] = [];

    if (defaultSlideId) {
      requests.push({ deleteObject: { objectId: defaultSlideId } });
    }

    requests.push(
      {
        createSlide: {
          objectId: "titleSlide",
          insertionIndex: 0,
          slideLayoutReference: { predefinedLayout: "TITLE" },
          placeholderIdMappings: [{ layoutPlaceholder: { type: "TITLE", index: 0 }, objectId: "titleSlide_title" }],
        },
      },
      { insertText: { objectId: "titleSlide_title", text: outline.title, insertionIndex: 0 } }
    );

    outline.slides.forEach((slide, i) => {
      const slideId = `slide_${i}`;
      const titleId = `${slideId}_title`;
      const bodyId = `${slideId}_body`;
      requests.push({
        createSlide: {
          objectId: slideId,
          insertionIndex: i + 1,
          slideLayoutReference: { predefinedLayout: "TITLE_AND_BODY" },
          placeholderIdMappings: [
            { layoutPlaceholder: { type: "TITLE", index: 0 }, objectId: titleId },
            { layoutPlaceholder: { type: "BODY", index: 0 }, objectId: bodyId },
          ],
        },
      });
      requests.push({ insertText: { objectId: titleId, text: slide.title, insertionIndex: 0 } });
      if (slide.bullets.length > 0) {
        requests.push({ insertText: { objectId: bodyId, text: slide.bullets.join("\n"), insertionIndex: 0 } });
        requests.push({
          createParagraphBullets: {
            objectId: bodyId,
            bulletPreset: "BULLET_DISC_CIRCLE_SQUARE",
            textRange: { type: "ALL" },
          },
        });
      }
    });

    const batchResponse = await fetchWithRetry(`${SLIDES_PRESENTATIONS_URL}/${presentationId}:batchUpdate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requests }),
    });
    if (!batchResponse.ok) {
      throw await apiError("Google Slides presentation population failed", batchResponse);
    }

    // presentations.create's response never includes webViewLink (it's a
    // Drive-level field, not a Slides-API one) — fetched separately via
    // Drive, whose file id space is shared with Slides' presentationId.
    const file = await this.driveClient.getFile(presentationId, resolvedAccount);
    return { file, slideCount: outline.slides.length };
  }
}
