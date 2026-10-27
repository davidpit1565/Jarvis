import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { CanvaClient } from "@/canva/CanvaClient";
import type { CanvaExportFormat } from "@/types/canva";
import type { TelegramGateway } from "@/communication/telegram/TelegramGateway";

export interface ExportCanvaDesignInput extends Record<string, unknown> {
  /** The design's id — from LIST_CANVA_DESIGNS or a design just created with CREATE_CANVA_DESIGN. */
  designId: string;
  /** Export format. Defaults to "pdf" — the generic "give me this as a file" choice. */
  format?: CanvaExportFormat;
  /** Which pages to export (1-indexed) for a multi-page design. Omit to export every page. */
  pages?: number[];
}

const VALID_FORMATS: readonly CanvaExportFormat[] = ["pdf", "png", "jpg", "pptx"];

// Images sent as a real inline Telegram photo rather than a generic
// document — same reasoning/constant as SHARE_FILE_TO_PHONE's
// INLINE_PHOTO_EXTENSIONS, just scoped to the formats this tool can
// actually produce (no .gif/.webp export here).
const INLINE_PHOTO_FORMATS = new Set<CanvaExportFormat>(["png", "jpg"]);

/**
 * Exports an existing Canva design to a downloadable file (PDF/PNG/JPG/
 * PPTX) and, when a Telegram owner chat is configured, delivers it there
 * directly — the natural follow-up to CREATE_CANVA_DESIGN/LIST_CANVA_DESIGNS
 * once David actually wants the file itself, not just a link to open in
 * Canva.
 *
 * DELIVERY MECHANISM (why this doesn't use SHARE_FILE_TO_PHONE): Canva's
 * export job hands back a temporary download URL, not bytes. SHARE_FILE_TO_PHONE
 * only accepts base64Content the caller already has in hand (from
 * READ_FILE_BYTES on a local file) — extending it to also fetch an
 * arbitrary caller-supplied URL would turn a narrow, already-reviewed tool
 * into a general-purpose URL-fetcher, a meaningfully bigger safety surface
 * for a SAFE_ACTION-tier tool. Downloading the export into this process
 * and then handing bytes to SHARE_FILE_TO_PHONE was also considered and
 * rejected: this runs on a small Fly machine, and buffering a PDF/PPTX
 * here just to immediately re-upload it burns memory for no benefit.
 * Instead this follows the pattern GENERATE_IMAGE already established for
 * exactly this situation (a provider hands back a URL, not bytes):
 * TelegramGateway.sendPhoto already fetches a Pollinations URL directly;
 * this adds its document-shaped sibling, TelegramGateway.sendDocumentByUrl,
 * so Telegram's own servers fetch the Canva export URL — the bytes never
 * pass through this process at all, and the export's 24-hour URL expiry
 * is a non-issue since it's handed off immediately. The export URL is
 * also always returned in the result, so it's still usable even without
 * Telegram configured, or if that delivery attempt fails.
 *
 * READ-tier (see CanvaClient.exportDesign's own doc comment): like
 * LIST_CANVA_DESIGNS/LIST_CANVA_BRAND_TEMPLATES, this never changes
 * anything in David's Canva account — it only produces a copy of a design
 * that already exists. CREATE_CANVA_DESIGN is CONFIRM because it adds a
 * new design to his account; this doesn't.
 */
export function createExportCanvaDesignTool(
  canvaClient: CanvaClient,
  telegramGateway?: TelegramGateway,
  ownerChatId?: string
): LocalTool<ExportCanvaDesignInput> {
  return {
    id: "EXPORT_CANVA_DESIGN",
    name: "export_canva_design",
    description:
      "Exports an existing Canva design as a downloadable file (pdf/png/jpg/pptx — defaults to pdf) and, if a " +
      "Telegram owner chat is configured, sends it there directly. Use LIST_CANVA_DESIGNS first to find the " +
      "designId. Always returns the export's download URL (valid for 24 hours) even if Telegram delivery isn't " +
      "configured or fails. Requires a linked Canva account.",
    inputSchema: {
      type: "object",
      properties: {
        designId: { type: "string", description: "The design's id, from LIST_CANVA_DESIGNS." },
        format: {
          type: "string",
          enum: VALID_FORMATS as unknown as string[],
          description: "Export format. Defaults to pdf.",
        },
        pages: {
          type: "array",
          items: { type: "number" },
          description: "1-indexed page numbers to export for a multi-page design. Omit to export every page.",
        },
      },
      required: ["designId"],
    },
    requiredPermission: PermissionLevel.READ,
    target: "local",

    async execute(input) {
      const designId = typeof input.designId === "string" ? input.designId.trim() : "";
      if (!designId) {
        return { success: false, error: "designId must be a non-empty string" };
      }

      const format: CanvaExportFormat = input.format !== undefined ? (input.format as CanvaExportFormat) : "pdf";
      if (!VALID_FORMATS.includes(format)) {
        return { success: false, error: `format must be one of: ${VALID_FORMATS.join(", ")}` };
      }

      let pages: number[] | undefined;
      if (input.pages !== undefined) {
        if (!Array.isArray(input.pages) || !input.pages.every((p) => typeof p === "number" && Number.isInteger(p) && p >= 1)) {
          return { success: false, error: "pages must be an array of positive integers" };
        }
        pages = input.pages as number[];
      }

      let exportResult;
      try {
        exportResult = await canvaClient.exportDesign(designId, format, { pages });
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }

      const base = { designId, format: exportResult.format, urls: exportResult.urls };

      if (telegramGateway && ownerChatId && exportResult.urls.length > 0) {
        try {
          if (INLINE_PHOTO_FORMATS.has(format)) {
            for (const url of exportResult.urls) {
              await telegramGateway.sendPhoto(ownerChatId, url);
            }
          } else {
            await telegramGateway.sendDocumentByUrl(ownerChatId, exportResult.urls[0]!);
          }
        } catch (error) {
          // Best-effort delivery — the URL itself is still returned below,
          // same "degrade honestly, never fail silently" pattern as
          // GENERATE_IMAGE's own Telegram delivery.
          return {
            success: true,
            data: { ...base, telegramDelivery: `failed: ${error instanceof Error ? error.message : String(error)}` },
          };
        }
        return { success: true, data: { ...base, telegramDelivery: "sent" } };
      }

      return { success: true, data: base };
    },
  };
}
