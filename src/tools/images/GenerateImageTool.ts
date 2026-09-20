import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { PollinationsImageClient } from "@/images/PollinationsImageClient";
import type { TelegramGateway } from "@/communication/telegram/TelegramGateway";

export interface GenerateImageInput extends Record<string, unknown> {
  prompt: string;
  width?: number;
  height?: number;
}

const MAX_PROMPT_LENGTH = 2000;

/**
 * Generates a real image from a text prompt — free, no API key, via
 * Pollinations.ai (see PollinationsImageClient's doc comment; verified
 * live during development). Always returns the image URL in the result
 * so any channel can use it; when a Telegram owner chat is configured,
 * also pushes it there as a real inline photo (Telegram fetches the URL
 * server-side — the bytes never pass through Core). SAFE_ACTION: the
 * effect (one generated image from a given prompt) is fully specified,
 * same reasoning as SEND_EMAIL — this never touches anything the user
 * didn't explicitly ask for.
 */
export function createGenerateImageTool(
  imageClient: PollinationsImageClient,
  telegramGateway?: TelegramGateway,
  ownerChatId?: string
): LocalTool<GenerateImageInput> {
  return {
    id: "GENERATE_IMAGE",
    name: "generate_image",
    description:
      "Generates a real image from a text prompt (free, no cost) and returns its URL. If a Telegram owner " +
      'chat is configured, also sends it there as a photo. Use for "make me an image of...", "generate a ' +
      'picture of...", etc. Write a clear, descriptive prompt — this is a real generative model, not a search ' +
      "engine, so specificity (style, subject, composition) matters.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Description of the image to generate." },
        width: { type: "number", description: "Image width in pixels. Defaults to 1024, capped at 1536." },
        height: { type: "number", description: "Image height in pixels. Defaults to 1024, capped at 1536." },
      },
      required: ["prompt"],
    },
    requiredPermission: PermissionLevel.SAFE_ACTION,
    target: "local",

    async execute(input) {
      const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
      if (!prompt) {
        return { success: false, error: "prompt must be a non-empty string" };
      }
      if (prompt.length > MAX_PROMPT_LENGTH) {
        return { success: false, error: `prompt is too long (over ${MAX_PROMPT_LENGTH} characters)` };
      }
      const width = typeof input.width === "number" ? input.width : undefined;
      const height = typeof input.height === "number" ? input.height : undefined;

      const url = imageClient.buildImageUrl(prompt, { width, height });

      if (telegramGateway && ownerChatId) {
        try {
          await telegramGateway.sendPhoto(ownerChatId, url, prompt);
        } catch (error) {
          // Best-effort delivery — the URL itself is still returned below,
          // so a Telegram hiccup doesn't fail the whole tool call.
          return {
            success: true,
            data: { url, prompt, telegramDelivery: `failed: ${error instanceof Error ? error.message : String(error)}` },
          };
        }
      }

      return { success: true, data: { url, prompt } };
    },
  };
}
