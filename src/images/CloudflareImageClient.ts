const CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com/client/v4";

/**
 * `@cf/black-forest-labs/flux-1-schnell` — Black Forest Labs' FLUX.1
 * [schnell] text-to-image model, hosted on Cloudflare Workers AI. Verified
 * against Cloudflare's own current model docs
 * (https://developers.cloudflare.com/workers-ai/models/flux-1-schnell/,
 * checked 2026-10-26): a real, modern diffusion model (the same FLUX
 * family Pollinations.ai's own free tier is built on — see
 * PollinationsImageClient's doc comment — but called here directly against
 * Cloudflare's own hosted copy, with full control over steps/output,
 * rather than through Pollinations' public proxy), covered by the exact
 * same free 10,000-Neurons/day allocation already used for
 * `CloudflareWorkersAIBrain`'s text models — see that class's own doc
 * comment for why that allocation is genuinely $0 (further calls simply
 * fail once exhausted; Cloudflare's docs are explicit that this does not
 * silently start billing a card on file).
 */
export const DEFAULT_IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";

/** flux-1-schnell's own documented max — more steps can improve quality but cost more Neurons per image and take longer. */
const MAX_STEPS = 8;
const DEFAULT_STEPS = 4;

export interface GenerateImageOptions {
  /** Diffusion steps (1-8, default 4) — higher can improve quality at the cost of more Neurons and latency. */
  steps?: number;
  /** Fixed seed for a reproducible result — same prompt+seed always generates the same image. */
  seed?: number;
}

export interface GeneratedImage {
  /** Base64-encoded image bytes, exactly as Cloudflare returns them — this provider has no hosted URL to hand back, unlike Pollinations. */
  base64: string;
  /** Always "image/jpeg" — flux-1-schnell's documented output format. */
  mimeType: string;
}

interface FluxRunResponse {
  result?: { image?: string };
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
}

/**
 * Calls Cloudflare Workers AI's raw `POST /accounts/{id}/ai/run/{model}`
 * endpoint (verified against Cloudflare's own current docs, same base URL
 * and auth header `CloudflareWorkersAIBrain` already uses for its separate
 * OpenAI-compatible chat endpoint — this is a different Cloudflare Workers
 * AI endpoint, not the same request shape) to generate a real image from a
 * text prompt. Returns the image inline as base64 — Cloudflare's `ai/run`
 * endpoint has no concept of a hosted, fetchable image URL the way
 * Pollinations.ai does, so callers that need a URL (e.g. Telegram's
 * `sendPhoto`) must instead upload these bytes directly (see
 * `TelegramGateway.sendPhotoBytes`) or embed them as a `data:` URI.
 */
export class CloudflareImageClient {
  private readonly accountId: string;
  private readonly apiToken: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(
    accountId: string | undefined,
    apiToken: string | undefined,
    options: { model?: string; baseUrl?: string } = {}
  ) {
    if (!accountId || !accountId.trim()) {
      throw new Error(
        "CloudflareImageClient requires a Cloudflare account id — set CLOUDFLARE_ACCOUNT_ID to the account id " +
          "shown on any zone/account overview page in the Cloudflare dashboard."
      );
    }
    if (!apiToken || !apiToken.trim()) {
      throw new Error(
        "CloudflareImageClient requires a Cloudflare API token — set CLOUDFLARE_API_TOKEN to a token created " +
          'under My Profile > API Tokens with "Workers AI" read/edit permission.'
      );
    }
    this.accountId = accountId;
    this.apiToken = apiToken;
    this.model = options.model ?? DEFAULT_IMAGE_MODEL;
    this.baseUrl = options.baseUrl ?? CLOUDFLARE_API_BASE_URL;
  }

  async generateImage(prompt: string, options: GenerateImageOptions = {}): Promise<GeneratedImage> {
    const steps = clampSteps(options.steps);
    const body: Record<string, unknown> = { prompt, steps };
    if (options.seed !== undefined) body.seed = options.seed;

    const url = `${this.baseUrl}/accounts/${this.accountId}/ai/run/${this.model}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Cloudflare image generation failed (${response.status}): ${detail}`);
    }

    const parsed = (await response.json()) as FluxRunResponse;
    if (!parsed.success || !parsed.result?.image) {
      const errorDetail = parsed.errors?.map((e) => e.message).join("; ") || "no image in response";
      throw new Error(`Cloudflare image generation failed: ${errorDetail}`);
    }

    return { base64: parsed.result.image, mimeType: "image/jpeg" };
  }
}

function clampSteps(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return DEFAULT_STEPS;
  return Math.min(Math.max(Math.round(value), 1), MAX_STEPS);
}
