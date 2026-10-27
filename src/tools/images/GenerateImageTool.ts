import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { PollinationsImageClient } from "@/images/PollinationsImageClient";
import type { CloudflareImageClient } from "@/images/CloudflareImageClient";
import type { TelegramGateway } from "@/communication/telegram/TelegramGateway";

export interface GenerateImageInput extends Record<string, unknown> {
  prompt: string;
  width?: number;
  height?: number;
}

const MAX_PROMPT_LENGTH = 2000;

/**
 * Generates a real image from a text prompt — free, no paid API required
 * either way.
 *
 * Prefers `cloudflareImageClient` (Cloudflare Workers AI's hosted
 * flux-1-schnell model — see CloudflareImageClient's own doc comment) when
 * it's configured: real, modern diffusion-model quality, covered by the
 * same free daily Neurons allocation already used for Cloudflare's text
 * models. Falls back to `PollinationsImageClient` (Pollinations.ai, no API
 * key or account at all — see its own doc comment) when Cloudflare isn't
 * configured, so GENERATE_IMAGE still works with zero configuration the
 * way it always has.
 *
 * (Gemini's own native image-generation models — e.g.
 * `gemini-2.5-flash-image`/`gemini-3.1-flash-image`, "Nano Banana" —
 * were investigated as a possible better-quality option here, since
 * `GEMINI_API_KEY` is already wired for `GeminiBrain`. As of this writing
 * (2026-10-26, verified against Google's own current pricing docs at
 * https://ai.google.dev/gemini-api/docs/pricing) every current Gemini
 * image-generation model's Free Tier price is listed as "Not available" —
 * image generation is a paid-tier-only capability on the Gemini API, not
 * something a bare `GEMINI_API_KEY` free-tier key can call — so it was
 * deliberately NOT wired in here: doing so would have silently required
 * billing for anyone using JARVIS's existing free Gemini setup, which
 * contradicts this project's explicit "always find the free option"
 * stance. Cloudflare's flux-1-schnell was substituted instead: a real
 * quality upgrade over Pollinations that stays genuinely free.)
 *
 * Always returns the generated image in the result (`data.url`: a real
 * fetchable URL for Pollinations, or a `data:` URI embedding the image
 * bytes for Cloudflare, so any consumer can use it the same way either
 * way) plus `data.source` naming which provider actually served the
 * request. When a Telegram owner chat is configured, also pushes it there
 * as a real inline photo — fetched by Telegram itself from the URL for
 * Pollinations, or uploaded directly from the bytes already in hand for
 * Cloudflare (see `TelegramGateway.sendPhotoBytes`). SAFE_ACTION: the
 * effect (one generated image from a given prompt) is fully specified,
 * same reasoning as SEND_EMAIL — this never touches anything the user
 * didn't explicitly ask for.
 */
export function createGenerateImageTool(
  imageClient: PollinationsImageClient,
  telegramGateway?: TelegramGateway,
  ownerChatId?: string,
  cloudflareImageClient?: CloudflareImageClient
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

      // Prefer Cloudflare's flux-1-schnell when configured — real quality
      // upgrade over Pollinations, same free-tier guarantee (see this
      // function's own doc comment). It returns inline bytes, not a
      // fetchable URL, so it's handled as its own branch rather than
      // forced into PollinationsImageClient's URL-shaped contract.
      if (cloudflareImageClient) {
        let generated;
        try {
          generated = await cloudflareImageClient.generateImage(prompt);
        } catch (error) {
          // The "better" option failed (rate limit, transient Cloudflare
          // error, daily Neurons allocation exhausted) — fall back to the
          // always-available free Pollinations path rather than failing
          // the whole tool call outright.
          const url = imageClient.buildImageUrl(prompt, { width, height });
          const fallbackReason = error instanceof Error ? error.message : String(error);
          return deliverPollinationsResult(url, prompt, telegramGateway, ownerChatId, fallbackReason);
        }

        const dataUrl = `data:${generated.mimeType};base64,${generated.base64}`;
        if (telegramGateway && ownerChatId) {
          try {
            await telegramGateway.sendPhotoBytes(ownerChatId, generated.base64, prompt);
          } catch (error) {
            return {
              success: true,
              data: {
                url: dataUrl,
                prompt,
                source: "cloudflare",
                telegramDelivery: `failed: ${error instanceof Error ? error.message : String(error)}`,
              },
            };
          }
        }
        return { success: true, data: { url: dataUrl, prompt, source: "cloudflare" } };
      }

      const url = imageClient.buildImageUrl(prompt, { width, height });
      return deliverPollinationsResult(url, prompt, telegramGateway, ownerChatId);
    },
  };
}

/**
 * Shared delivery path for the free, always-available Pollinations.ai
 * provider — used both as GENERATE_IMAGE's default (no Cloudflare
 * configured) and as the fallback when a configured Cloudflare call fails.
 * `fallbackReason`, when given, is folded into the result so a caller
 * (and anyone reading tool-call logs) can see the better option was tried
 * and why it didn't serve this particular request, without failing the
 * call outright — same "degrade honestly, never fail silently" pattern
 * this tool already applies to a failed Telegram delivery below.
 */
async function deliverPollinationsResult(
  url: string,
  prompt: string,
  telegramGateway?: TelegramGateway,
  ownerChatId?: string,
  fallbackReason?: string
) {
  const base = { url, prompt, source: "pollinations" as const, ...(fallbackReason ? { cloudflareFallback: fallbackReason } : {}) };

  if (telegramGateway && ownerChatId) {
    try {
      await telegramGateway.sendPhoto(ownerChatId, url, prompt);
    } catch (error) {
      // Best-effort delivery — the URL itself is still returned below,
      // so a Telegram hiccup doesn't fail the whole tool call.
      return {
        success: true,
        data: { ...base, telegramDelivery: `failed: ${error instanceof Error ? error.message : String(error)}` },
      };
    }
  }

  return { success: true, data: base };
}
