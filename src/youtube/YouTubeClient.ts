import type { CalendarTokenStore } from "@/calendar/CalendarTokenStore";
import type { YouTubeChannel, YouTubeVideoStats, YouTubeVideoSummary } from "@/types/youtube";
import { fetchWithRetry } from "@/core/net/fetchWithRetry";
import { apiError } from "@/core/net/apiError";

const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const YOUTUBE_API_BASE_URL = "https://www.googleapis.com/youtube/v3";

// Same margin as GoogleCalendarClient/GmailClient/GoogleDriveClient, for
// the same reason: refresh a little before actual expiry so a request
// never straddles it.
const TOKEN_EXPIRY_SAFETY_MARGIN_MS = 60_000;

// Same reasoning as every other client's own cap in this codebase — a
// caller passing an unreasonably large count shouldn't pull an unbounded
// page of videos (and their full field set) in one call.
const MAX_RESULTS_CAP = 25;
const DEFAULT_RESULTS = 10;

const NO_ACCOUNT_LINKED_ERROR = "No Google account linked yet — visit GET /calendar/oauth/start to connect one.";

interface RawYouTubeChannel {
  id: string;
  snippet?: { title?: string };
  statistics?: { subscriberCount?: string; videoCount?: string };
  contentDetails?: { relatedPlaylists?: { uploads?: string } };
}

interface RawPlaylistItem {
  snippet?: { title?: string; publishedAt?: string; resourceId?: { videoId?: string } };
}

interface RawVideo {
  id: string;
  snippet?: { title?: string };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
}

/**
 * YouTube Data API v3 access via raw fetch calls — same no-SDK style as
 * GmailClient/GoogleDriveClient. Added 2026-10-27 on David's explicit
 * request ("he has his own channel/videos he wants JARVIS aware of"),
 * read-only (youtube.readonly — see GoogleCalendarClient's GOOGLE_SCOPES),
 * no publish/upload/comment capability at all.
 *
 * Shares its OAuth tokens with GoogleCalendarClient/GmailClient/
 * GoogleDriveClient (same CalendarTokenStore, same Google account link)
 * rather than requiring a separate account link or a second set of
 * credentials — the YouTube Data API accepts the same Google OAuth token
 * as every other Google API here, just with its own scope.
 *
 * Operates over EVERY account CalendarTokenStore has linked, same as
 * GmailClient/GoogleDriveClient — a read without an explicit `account`
 * resolves to whichever account was linked first (see `primaryAccount()`),
 * since "my channel" only makes sense for one specific account at a time
 * (unlike Gmail search, there's no sensible way to merge two different
 * people's channels into one answer).
 */
export class YouTubeClient {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly tokenStore: CalendarTokenStore
  ) {}

  /** Every linked account's email, oldest-linked (primary) first. */
  linkedAccounts(): string[] {
    return this.tokenStore.getAll().map((a) => a.email);
  }

  /** The account a read defaults to when none is specified — whichever was linked first — or null if nothing is linked. */
  primaryAccount(): string | null {
    return this.tokenStore.getAll()[0]?.email ?? null;
  }

  private async refreshAccessToken(email: string, refreshToken: string): Promise<string> {
    const response = await fetchWithRetry(GOOGLE_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: "refresh_token",
      }).toString(),
    });

    if (!response.ok) {
      throw await apiError("Google OAuth token refresh failed", response);
    }

    const data = (await response.json()) as { access_token: string; expires_in: number };
    const expiresAt = Date.now() + data.expires_in * 1000;
    this.tokenStore.updateAccessToken(email, data.access_token, expiresAt);
    return data.access_token;
  }

  private async getValidAccessToken(email: string): Promise<string> {
    const tokens = this.tokenStore.get(email);
    if (!tokens) {
      throw new Error(`No Google account linked as ${email}.`);
    }

    const stillValid =
      tokens.accessToken !== null &&
      tokens.accessTokenExpiresAt !== null &&
      tokens.accessTokenExpiresAt - TOKEN_EXPIRY_SAFETY_MARGIN_MS > Date.now();

    if (stillValid) return tokens.accessToken!;
    return this.refreshAccessToken(email, tokens.refreshToken);
  }

  /** Resolves which account a read should use: the explicit account if given (must actually be linked), else the primary (first-linked) account. */
  private resolveAccount(explicit?: string): string {
    if (explicit) {
      if (!this.tokenStore.isLinked(explicit)) {
        throw new Error(
          `No Google account linked as ${explicit}. Linked accounts: ${this.linkedAccounts().join(", ") || "(none)"}.`
        );
      }
      return explicit;
    }
    const primary = this.primaryAccount();
    if (!primary) throw new Error(NO_ACCOUNT_LINKED_ERROR);
    return primary;
  }

  private async getChannel(accessToken: string, parts: string): Promise<RawYouTubeChannel> {
    const url = new URL(`${YOUTUBE_API_BASE_URL}/channels`);
    url.searchParams.set("mine", "true");
    url.searchParams.set("part", parts);

    const response = await fetchWithRetry(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) {
      throw await apiError("YouTube channel lookup failed", response);
    }

    const data = (await response.json()) as { items?: RawYouTubeChannel[] };
    const channel = data.items?.[0];
    if (!channel) {
      throw new Error("No YouTube channel found for this Google account.");
    }
    return channel;
  }

  /** Basic info about David's own channel: id, title, subscriber/video counts. */
  async getMyChannel(account?: string): Promise<YouTubeChannel> {
    const resolvedAccount = this.resolveAccount(account);
    const accessToken = await this.getValidAccessToken(resolvedAccount);
    const channel = await this.getChannel(accessToken, "snippet,statistics");

    return {
      id: channel.id,
      title: channel.snippet?.title ?? "(untitled channel)",
      subscriberCount: Number(channel.statistics?.subscriberCount ?? 0),
      videoCount: Number(channel.statistics?.videoCount ?? 0),
      account: resolvedAccount,
    };
  }

  /**
   * His own uploaded videos, newest first. This needs two API calls, not
   * one, because the YouTube Data API has no "list my uploads" endpoint
   * directly: a channel's uploads live in a specific, auto-generated
   * playlist (channels.list's `contentDetails.relatedPlaylists.uploads`),
   * so the first call resolves that playlist's id and the second actually
   * lists its items (playlistItems.list) — the standard pattern for this,
   * per YouTube's own API docs.
   */
  async listMyVideos(maxResults: number = DEFAULT_RESULTS, account?: string): Promise<YouTubeVideoSummary[]> {
    const capped = Math.min(maxResults, MAX_RESULTS_CAP);
    const resolvedAccount = this.resolveAccount(account);
    const accessToken = await this.getValidAccessToken(resolvedAccount);

    const channel = await this.getChannel(accessToken, "contentDetails");
    const uploadsPlaylistId = channel.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsPlaylistId) {
      throw new Error("Could not find an uploads playlist for this YouTube channel.");
    }

    const url = new URL(`${YOUTUBE_API_BASE_URL}/playlistItems`);
    url.searchParams.set("playlistId", uploadsPlaylistId);
    url.searchParams.set("part", "snippet");
    url.searchParams.set("maxResults", String(capped));

    const response = await fetchWithRetry(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) {
      throw await apiError("YouTube uploads list failed", response);
    }

    const data = (await response.json()) as { items?: RawPlaylistItem[] };
    const items = data.items ?? [];

    return items
      .filter((item) => item.snippet?.resourceId?.videoId)
      .map((item) => ({
        id: item.snippet!.resourceId!.videoId!,
        title: item.snippet?.title ?? "(untitled video)",
        publishedAt: item.snippet?.publishedAt ?? "",
        url: `https://www.youtube.com/watch?v=${item.snippet!.resourceId!.videoId!}`,
        account: resolvedAccount,
      }));
  }

  /** Views/likes/comment count for one video, by its YouTube video id. */
  async getVideoStats(videoId: string, account?: string): Promise<YouTubeVideoStats> {
    const resolvedAccount = this.resolveAccount(account);
    const accessToken = await this.getValidAccessToken(resolvedAccount);

    const url = new URL(`${YOUTUBE_API_BASE_URL}/videos`);
    url.searchParams.set("id", videoId);
    url.searchParams.set("part", "statistics,snippet");

    const response = await fetchWithRetry(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) {
      throw await apiError("YouTube video stats lookup failed", response);
    }

    const data = (await response.json()) as { items?: RawVideo[] };
    const video = data.items?.[0];
    if (!video) {
      throw new Error(`No YouTube video found with id "${videoId}".`);
    }

    return {
      id: video.id,
      title: video.snippet?.title ?? "(untitled video)",
      viewCount: Number(video.statistics?.viewCount ?? 0),
      likeCount: Number(video.statistics?.likeCount ?? 0),
      commentCount: Number(video.statistics?.commentCount ?? 0),
      account: resolvedAccount,
    };
  }
}
