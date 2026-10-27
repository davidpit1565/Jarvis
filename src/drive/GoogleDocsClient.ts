import type { GoogleDriveClient } from "@/drive/GoogleDriveClient";
import type { DriveFile } from "@/types/drive";
import { fetchWithRetry } from "@/core/net/fetchWithRetry";
import { apiError } from "@/core/net/apiError";

const DOCS_DOCUMENTS_URL = "https://docs.googleapis.com/v1/documents";

// Mirrors GoogleSlidesClient's own MAX_SLIDES reasoning: reject an
// obviously-wrong input (an empty checklist, or an unreasonably huge one)
// before ever calling the API.
const MAX_ITEMS = 200;

interface RawDocument {
  documentId: string;
}

/**
 * Google Docs access via raw fetch calls to the Docs v1 REST API — same
 * no-SDK style as the rest of this package. Implements the CREATE_CHECKLIST
 * tool's templating layer: given a title and a flat list of item strings,
 * creates a new Doc and turns the items into a REAL checkbox list (not
 * plain bullets) via `batchUpdate`.
 *
 * Request shape verified against Google's own current Docs API
 * documentation (developers.google.com/workspace/docs/api/how-tos/lists):
 * insert the items as one `insertText` (newline-separated) at index 1 (the
 * first real content index in a brand-new document — index 0 is the
 * document's own start-of-body boundary, not writable text), then a
 * `createParagraphBullets` over the inserted range with
 * `bulletPreset: "BULLET_CHECKBOX"` — the Docs API's own glyph preset for
 * an actual checkbox glyph at every list level, confirmed as a documented
 * `BulletGlyphPreset` value and a drop-in substitute for the bullet/numbered
 * presets shown in Google's own list-creation sample (which uses
 * `BULLET_ARROW_DIAMOND_DISC`/`NUMBERED_DECIMAL_ALPHA_ROMAN` in the exact
 * same request shape).
 */
export class GoogleDocsClient {
  constructor(private readonly driveClient: GoogleDriveClient) {}

  async createChecklist(title: string, items: string[], account?: string): Promise<{ file: DriveFile; itemCount: number }> {
    if (items.length === 0) {
      throw new Error("A checklist needs at least one item.");
    }
    if (items.length > MAX_ITEMS) {
      throw new Error(`A checklist can have at most ${MAX_ITEMS} items (got ${items.length}).`);
    }

    const resolvedAccount = this.driveClient.resolveAccount(account);
    const accessToken = await this.driveClient.getValidAccessToken(resolvedAccount);

    const createResponse = await fetchWithRetry(DOCS_DOCUMENTS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (!createResponse.ok) {
      throw await apiError("Google Docs document creation failed", createResponse);
    }
    const document = (await createResponse.json()) as RawDocument;
    const documentId = document.documentId;

    // Every item followed by "\n" so each becomes its own paragraph — the
    // Docs API sample this is modeled on (see class doc comment) does the
    // same for its numbered-list example. The body starts at index 1 (index
    // 0 is a non-writable document-start boundary), so the inserted range
    // spans [1, 1 + text.length).
    const text = items.map((item) => item.trim()).join("\n") + "\n";
    const endIndex = 1 + text.length;

    const batchResponse = await fetchWithRetry(`${DOCS_DOCUMENTS_URL}/${documentId}:batchUpdate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [
          { insertText: { location: { index: 1 }, text } },
          { createParagraphBullets: { range: { startIndex: 1, endIndex }, bulletPreset: "BULLET_CHECKBOX" } },
        ],
      }),
    });
    if (!batchResponse.ok) {
      throw await apiError("Google Docs checklist population failed", batchResponse);
    }

    // documents.create's response never includes webViewLink (same
    // reasoning as GoogleSlidesClient) — fetched via Drive, whose file id
    // space is shared with Docs' documentId.
    const file = await this.driveClient.getFile(documentId, resolvedAccount);
    return { file, itemCount: items.length };
  }
}
