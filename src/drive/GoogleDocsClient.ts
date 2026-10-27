import type { GoogleDriveClient } from "@/drive/GoogleDriveClient";
import type { DriveFile } from "@/types/drive";
import { fetchWithRetry } from "@/core/net/fetchWithRetry";
import { apiError } from "@/core/net/apiError";

const DOCS_DOCUMENTS_URL = "https://docs.googleapis.com/v1/documents";

// Mirrors GoogleSlidesClient's own MAX_SLIDES reasoning: reject an
// obviously-wrong input (an empty checklist, or an unreasonably huge one)
// before ever calling the API.
const MAX_ITEMS = 200;

// Same reasoning as MAX_ITEMS above, applied to createDocument's richer
// shape: counts every heading + paragraph + bullet across every section, so
// an absurdly huge document (or one with an absurd number of sections) is
// rejected before ever calling the API.
const MAX_DOCUMENT_BLOCKS = 300;
const MAX_SECTIONS = 50;

interface RawDocument {
  documentId: string;
}

export interface DocumentSection {
  /** Section heading text. Omit for a section that's just body paragraphs/bullets with no heading of its own. */
  heading?: string;
  /** Plain prose paragraphs, rendered in order, one per paragraph. */
  paragraphs?: string[];
  /** A bullet list (real bullets, not a checkbox list — see createChecklist for that), rendered after any paragraphs in this section. */
  bullets?: string[];
}

// A single text run to insert, paired with the paragraph-level style request
// to apply to it afterwards (if any). Building this flat list first, then
// resolving every index from cumulative text length, is what keeps the
// insertion-index math in createDocument correct: the Docs API's insertText
// always targets the current end-of-document index, and every batchUpdate
// request list is applied top-to-bottom against a single evolving document,
// so inserting block N's text before computing block N+1's index (rather
// than computing all indices up front against the original empty document)
// avoids the classic off-by-the-length-of-everything-already-inserted bug.
interface DocBlock {
  /** The block's full text, already newline-joined if it spans multiple paragraphs (e.g. a bullet list). */
  text: string;
  /** "HEADING_1" etc, applied to the whole block's paragraph(s). Omitted for a plain-style paragraph. */
  namedStyleType?: string;
  /** True when this block's paragraph(s) should become a real bullet list (BULLET_DISC_CIRCLE_SQUARE), not a checkbox list — see createChecklist for that. */
  isBullet?: boolean;
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

  /**
   * Creates a new Google Doc and populates it with a REAL formatted
   * document — headed sections, plain prose paragraphs, and optional
   * bullet lists within a section — rather than createChecklist's narrower
   * flat checkbox list.
   *
   * `namedStyleType: "HEADING_1"` for section headings and
   * `bulletPreset: "BULLET_DISC_CIRCLE_SQUARE"` for bullet lists (a real
   * bulleted list, not the checkbox preset createChecklist uses) are both
   * verified current Docs API v1 values (developers.google.com/workspace/
   * docs/api/how-tos/format-text for UpdateParagraphStyleRequest +
   * NamedStyleType, developers.google.com/workspace/docs/api/reference/
   * rest/v1/documents/request for BulletGlyphPreset).
   *
   * Index math: rather than issuing one insertText per block (which would
   * require recomputing every later block's index after each insert, since
   * the Docs API's insert indices shift as earlier content lands), this
   * builds ONE concatenated text blob up front — each block's text plus a
   * trailing "\n" so it becomes its own paragraph, matching createChecklist's
   * own "join with \n, include the trailing newline in the styled range"
   * pattern — and computes every block's [startIndex, endIndex) from
   * cumulative offsets into that single string *before* any network call.
   * Because the subsequent style requests (updateParagraphStyle /
   * createParagraphBullets) don't themselves insert or delete text, those
   * precomputed ranges stay valid without any re-adjustment, and the whole
   * document (one insertText + one style request per heading/bullet block)
   * goes out as a single batchUpdate — the same "insert once, style in the
   * same call" efficiency createChecklist already uses, generalized to many
   * blocks instead of one.
   */
  async createDocument(title: string, sections: DocumentSection[], account?: string): Promise<{ file: DriveFile; blockCount: number }> {
    if (sections.length === 0) {
      throw new Error("A document needs at least one section.");
    }
    if (sections.length > MAX_SECTIONS) {
      throw new Error(`A document can have at most ${MAX_SECTIONS} sections (got ${sections.length}).`);
    }

    const blocks: DocBlock[] = [];
    for (const section of sections) {
      const heading = section.heading?.trim();
      const paragraphs = (section.paragraphs ?? []).map((p) => p.trim()).filter((p) => p !== "");
      const bullets = (section.bullets ?? []).map((b) => b.trim()).filter((b) => b !== "");

      if (!heading && paragraphs.length === 0 && bullets.length === 0) {
        continue; // an entirely empty section contributes nothing — skip rather than error
      }

      if (heading) {
        blocks.push({ text: heading, namedStyleType: "HEADING_1" });
      }
      for (const paragraph of paragraphs) {
        blocks.push({ text: paragraph });
      }
      if (bullets.length > 0) {
        blocks.push({ text: bullets.join("\n"), isBullet: true });
      }
    }

    if (blocks.length === 0) {
      throw new Error("A document needs at least one heading, paragraph, or bullet across its sections.");
    }

    // Count every individual heading/paragraph/bullet-item (not just
    // blocks — a bullet block can hold many items) against the cap, same
    // reasoning as MAX_ITEMS above.
    const itemCount = sections.reduce(
      (total, section) => total + (section.heading ? 1 : 0) + (section.paragraphs?.length ?? 0) + (section.bullets?.length ?? 0),
      0
    );
    if (itemCount > MAX_DOCUMENT_BLOCKS) {
      throw new Error(`A document can have at most ${MAX_DOCUMENT_BLOCKS} headings/paragraphs/bullets combined (got ${itemCount}).`);
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

    // Body content starts at index 1 (index 0 is a non-writable
    // document-start boundary), same as createChecklist.
    let cursor = 1;
    let fullText = "";
    const styleRequests: Record<string, unknown>[] = [];
    for (const block of blocks) {
      const blockText = `${block.text}\n`;
      const startIndex = cursor;
      const endIndex = cursor + blockText.length;
      fullText += blockText;

      if (block.namedStyleType) {
        styleRequests.push({
          updateParagraphStyle: {
            range: { startIndex, endIndex },
            paragraphStyle: { namedStyleType: block.namedStyleType },
            fields: "namedStyleType",
          },
        });
      } else if (block.isBullet) {
        styleRequests.push({
          createParagraphBullets: { range: { startIndex, endIndex }, bulletPreset: "BULLET_DISC_CIRCLE_SQUARE" },
        });
      }

      cursor = endIndex;
    }

    const batchResponse = await fetchWithRetry(`${DOCS_DOCUMENTS_URL}/${documentId}:batchUpdate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        // insertText must come first — the style requests below reference
        // ranges that only exist once the text has actually been inserted.
        requests: [{ insertText: { location: { index: 1 }, text: fullText } }, ...styleRequests],
      }),
    });
    if (!batchResponse.ok) {
      throw await apiError("Google Docs document population failed", batchResponse);
    }

    const file = await this.driveClient.getFile(documentId, resolvedAccount);
    return { file, blockCount: blocks.length };
  }
}
