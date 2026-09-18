const POLLINATIONS_BASE_URL = "https://image.pollinations.ai/prompt";

const MAX_DIMENSION = 1536;
const DEFAULT_WIDTH = 1024;
const DEFAULT_HEIGHT = 1024;

export interface GenerateImageOptions {
  width?: number;
  height?: number;
  /** Fixed seed for a reproducible result — same prompt+seed always generates the same image. */
  seed?: number;
}

/**
 * Builds a real, working, no-API-key, no-signup image generation URL via
 * Pollinations.ai (image.pollinations.ai/prompt/...) — verified live
 * during this session (fetched an actual generated JPEG with no auth of
 * any kind). Free Flux-model image generation, matching this project's
 * existing "as close to free as possible" philosophy (Open-Meteo for
 * weather, RSS for news, no paid vendor). Pollinations itself renders the
 * image server-side on request — this just builds the URL; the caller
 * (GenerateImageTool) hands that URL to Telegram's own sendPhoto, which
 * fetches it server-side too, so the image bytes never have to round-trip
 * through Core's own process or Claude's context at all.
 */
export class PollinationsImageClient {
  buildImageUrl(prompt: string, options: GenerateImageOptions = {}): string {
    const width = clampDimension(options.width, DEFAULT_WIDTH);
    const height = clampDimension(options.height, DEFAULT_HEIGHT);

    const url = new URL(`${POLLINATIONS_BASE_URL}/${encodeURIComponent(prompt)}`);
    url.searchParams.set("width", String(width));
    url.searchParams.set("height", String(height));
    if (options.seed !== undefined) {
      url.searchParams.set("seed", String(options.seed));
    }
    return url.toString();
  }
}

const MIN_DIMENSION = 64;

function clampDimension(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  // Rounding a small positive value (e.g. 0.4) before clamping could
  // otherwise still produce 0 — found during a later review: only the
  // upper bound was actually enforced, not a sane minimum.
  return Math.min(Math.max(Math.round(value), MIN_DIMENSION), MAX_DIMENSION);
}
