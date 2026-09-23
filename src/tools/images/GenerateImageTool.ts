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
      'picture of...", etc. This is a real generative model, not a search engine — prompt quality directly ' +
      "determines result quality, so build it yourself rather than passing the user's request through " +
      "verbatim. When the request is more than a simple subject, expand it into a single detailed prompt " +
      "that explicitly names: every distinct object/subject the user mentioned (a model is far more likely " +
      "to drop something you never wrote down than something you did — enumerate them, don't summarize " +
      "them away), composition/framing, camera angle or lens style if relevant, lighting, materials/colors, " +
      "and overall style (e.g. photorealistic, cinematic, illustration). State any exact text that must " +
      "appear verbatim in quotes, but set expectations honestly afterward: text rendering inside generated " +
      "images is unreliable on this provider, so exact spelling is not guaranteed even when requested " +
      "correctly. Don't invent creative details the user didn't ask for and that would change the meaning " +
      "of the request, but concrete technical descriptors that help the model realize what was actually " +
      "asked (framing, lighting, material) are expected, not optional. This provider has no negative-prompt " +
      "or reference-image support and a single generation attempt — if the result clearly missed something " +
      "critical the user asked for, say so plainly rather than presenting it as if it matched perfectly.",
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
