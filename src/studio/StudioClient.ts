import type { StudioInstagramStats, StudioPublishResult, StudioReel } from "@/types/studio";

/**
 * Talks to David's separate "actually-works" video studio project
 * (a Next.js app, repo davidpit1565/videos-ai) over its own small set of
 * machine-to-machine endpoints under /api/jarvis/* — reading which reels
 * are rendered and waiting for publish, reading real Instagram stats,
 * and triggering the exact same publish action the studio's own button
 * calls. Authenticated with a bearer secret (JARVIS_STUDIO_SECRET),
 * never the studio's browser-only PIN cookie, matching how the studio's
 * own nightly cron/hook callers authenticate to it.
 *
 * REQUIRES REAL VALIDATION: never exercised against the real deployed
 * studio.
 */
export class StudioClient {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string
  ) {}

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.secret}` };
  }

  /** Rendered reels waiting for/already through publish, soonest-built first (the studio's own order). */
  async listReels(): Promise<StudioReel[]> {
    const response = await fetch(new URL("/api/jarvis/reels", this.baseUrl), { headers: this.headers() });
    if (!response.ok) {
      throw new Error(`Studio reels request failed (${response.status}): ${await response.text().catch(() => "")}`);
    }
    const data = (await response.json()) as { ok: boolean; reason?: string; reels?: StudioReel[] };
    if (!data.ok) throw new Error(data.reason ?? "Studio reels request failed");
    return data.reels ?? [];
  }

  /** Real account stats: followers, and per-post views/reach/saves/shares/likes/comments. */
  async getInstagramStats(): Promise<StudioInstagramStats> {
    const response = await fetch(new URL("/api/jarvis/instagram", this.baseUrl), { headers: this.headers() });
    if (!response.ok) {
      throw new Error(`Studio Instagram request failed (${response.status}): ${await response.text().catch(() => "")}`);
    }
    return (await response.json()) as StudioInstagramStats;
  }

  /**
   * Publishes a rendered reel to Instagram (and, if that succeeds,
   * Facebook) — the exact same action the studio's own "publish" button
   * triggers. A real, irreversible public post: the caller is
   * responsible for having already confirmed with the user before this
   * is invoked, the same way the studio's own button asks first.
   */
  async publish(file: string, caption: string): Promise<StudioPublishResult> {
    const response = await fetch(new URL("/api/jarvis/publish", this.baseUrl), {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ file, caption }),
    });
    return (await response.json().catch(() => ({ ok: false, reason: `Unexpected response (${response.status})` }))) as StudioPublishResult;
  }
}
