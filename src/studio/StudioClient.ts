import { apiError } from "@/core/net/apiError";
import type { StudioInstagramStats, StudioPublishResult, StudioReel } from "@/types/studio";

/** Most recent posts/reels kept when reporting Instagram stats or the reel list — see getInstagramStats()'s doc comment for why this exists. */
const MAX_INSTAGRAM_MEDIA_ITEMS = 10;
/** Caption length kept per post/reel — full captions/hashtags are the single biggest contributor to response size. */
const MAX_CAPTION_LENGTH = 200;

function truncateCaption<T extends string | null | undefined>(caption: T): T {
  if (caption == null) return caption;
  return (caption.length > MAX_CAPTION_LENGTH ? `${caption.slice(0, MAX_CAPTION_LENGTH)}…` : caption) as T;
}

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

  /**
   * Rendered reels waiting for/already through publish, soonest-built first (the studio's
   * own order). Capped and caption-truncated the same way as getInstagramStats() — see its
   * doc comment; a studio with a long production history can return just as many reels as
   * it has Instagram posts, and this is the other half of one Telegram turn ("check the
   * studio") that calls both tools together, so both need to stay small on their own.
   */
  async listReels(): Promise<StudioReel[]> {
    const response = await fetch(new URL("/api/jarvis/reels", this.baseUrl), { headers: this.headers() });
    if (!response.ok) {
      throw await apiError("Studio reels request failed", response);
    }
    const data = (await response.json()) as { ok: boolean; reason?: string; reels?: StudioReel[] };
    if (!data.ok) throw new Error(data.reason ?? "Studio reels request failed");
    return (data.reels ?? []).slice(0, MAX_INSTAGRAM_MEDIA_ITEMS).map((reel) => ({
      file: reel.file,
      kind: reel.kind,
      episode: reel.episode,
      title: reel.title,
      caption: truncateCaption(reel.caption),
      builtAt: reel.builtAt,
      bytes: reel.bytes,
      gatePassed: reel.gatePassed,
    }));
  }

  /**
   * Real account stats: followers, and per-post views/reach/saves/shares/likes/comments.
   *
   * The studio's own API returns far more than `StudioInstagramStats` declares — extra
   * debug/status fields per post (e.g. `metricStatus`, `reachByFollowerTypeDebug`, raw
   * watch-time breakdowns) that were never meant for JARVIS to see, plus every post the
   * account has ever made. Blindly casting the raw JSON to `StudioInstagramStats` (as this
   * used to do) let all of that through at runtime despite the type claiming otherwise —
   * found the hard way: 43 real posts' full captions/hashtags plus that debug noise pushed
   * one request to ~13k tokens, well past Groq's free-tier per-minute limit for the
   * follow-up call that has to read the tool result. Explicitly reshaping the response to
   * only the declared fields, capping the post list, and trimming captions keeps this
   * genuinely small regardless of how many posts/fields the studio's API adds later.
   */
  async getInstagramStats(): Promise<StudioInstagramStats> {
    const response = await fetch(new URL("/api/jarvis/instagram", this.baseUrl), { headers: this.headers() });
    if (!response.ok) {
      throw await apiError("Studio Instagram request failed", response);
    }
    const raw = (await response.json()) as StudioInstagramStats;
    if (!raw.connected) return raw;
    return {
      connected: true,
      username: raw.username,
      followers: raw.followers,
      mediaCount: raw.mediaCount,
      media: raw.media.slice(0, MAX_INSTAGRAM_MEDIA_ITEMS).map((post) => ({
        id: post.id,
        caption: truncateCaption(post.caption),
        permalink: post.permalink,
        timestamp: post.timestamp,
        mediaType: post.mediaType,
        views: post.views,
        reach: post.reach,
        saves: post.saves,
        shares: post.shares,
        likes: post.likes,
        comments: post.comments,
      })),
    };
  }

  /**
   * Publishes a rendered reel to Instagram (and, if that succeeds,
   * Facebook) — the exact same action the studio's own "publish" button
   * triggers. A real, irreversible public post: the caller is
   * responsible for having already confirmed with the user before this
   * is invoked, the same way the studio's own button asks first.
   */
  async publish(file: string, caption?: string): Promise<StudioPublishResult> {
    const response = await fetch(new URL("/api/jarvis/publish", this.baseUrl), {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify(caption === undefined ? { file } : { file, caption }),
    });
    return (await response.json().catch(() => ({ ok: false, reason: `Unexpected response (${response.status})` }))) as StudioPublishResult;
  }
}
