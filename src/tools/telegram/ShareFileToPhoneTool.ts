import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { TelegramGateway } from "@/communication/telegram/TelegramGateway";

export interface ShareFileToPhoneInput extends Record<string, unknown> {
  base64Content: string;
  filename: string;
}

const MAX_BASE64_LENGTH = 250_000; // ~187KB raw — generous headroom over read_file_bytes's own 150KB cap.

// Extensions sent as a real inline Telegram photo (sendPhotoBytes) rather
// than a generic document (sendDocument) — matches what CAPTURE_SCREENSHOT
// produces (.png) plus the other common image types a user might ask to
// share, so "send me a picture" actually renders as a picture on the phone
// instead of a tap-to-download file attachment.
const INLINE_PHOTO_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

function isImageFilename(filename: string): boolean {
  const extension = filename.split(".").pop()?.toLowerCase();
  return extension !== undefined && INLINE_PHOTO_EXTENSIONS.has(extension);
}

/**
 * Delivers a file from the Mac to the user's phone via Telegram — real
 * cross-device file transfer, but honestly limited: it only works on
 * whatever base64Content the caller already has in hand from
 * read_file_bytes, which is itself capped at 150KB raw for context-cost
 * reasons (this content has to sit in Claude's own context to travel
 * from one tool call to the next — there's no direct device-to-Telegram
 * pipe in this codebase). Fine for a small document, note, or
 * thumbnail-sized image; will fail on anything bigger like a real photo
 * or video. SAFE_ACTION: fully specified effect (exact bytes, exact
 * filename) once called, same reasoning as SEND_EMAIL.
 *
 * Image files (by extension) are sent via TelegramGateway.sendPhotoBytes
 * so they render as a real inline photo — e.g. "picture from JARVIS" for
 * a screenshot — rather than TelegramGateway.sendDocument's generic file
 * attachment, which previously was used unconditionally here even though
 * sendPhotoBytes already existed for GENERATE_IMAGE's own delivery path.
 */
export function createShareFileToPhoneTool(telegramGateway: TelegramGateway, ownerChatId: string): LocalTool<ShareFileToPhoneInput> {
  return {
    id: "SHARE_FILE_TO_PHONE",
    name: "share_file_to_phone",
    description:
      "Sends a file to the user's phone via Telegram, given base64Content from a prior read_file_bytes call " +
      "(do not fabricate base64Content yourself) — e.g. use capture_screenshot then this tool to get a " +
      "screenshot to the phone. Image files (.png/.jpg/.jpeg/.gif/.webp) are delivered as a real inline photo; " +
      "anything else as a document. Only practical for small files since read_file_bytes itself caps at 150KB.",
    inputSchema: {
      type: "object",
      properties: {
        base64Content: { type: "string", description: "Base64-encoded file content, from a prior read_file_bytes call." },
        filename: { type: "string", description: "Filename to give the document on the phone, including extension." },
      },
      required: ["base64Content", "filename"],
    },
    requiredPermission: PermissionLevel.SAFE_ACTION,
    target: "local",

    async execute(input) {
      const base64Content = typeof input.base64Content === "string" ? input.base64Content : "";
      if (!base64Content.trim()) {
        return { success: false, error: "base64Content must be a non-empty string" };
      }
      if (base64Content.length > MAX_BASE64_LENGTH) {
        return { success: false, error: `base64Content is too large (over ${MAX_BASE64_LENGTH} characters)` };
      }
      const filename = typeof input.filename === "string" ? input.filename.trim() : "";
      if (!filename) {
        return { success: false, error: "filename must be a non-empty string" };
      }

      try {
        if (isImageFilename(filename)) {
          await telegramGateway.sendPhotoBytes(ownerChatId, base64Content);
        } else {
          await telegramGateway.sendDocument(ownerChatId, base64Content, filename);
        }
        return { success: true, data: { filename, sent: true } };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
