import type { SpotifyTokenStore } from "@/spotify/SpotifyTokenStore";
import type { SpotifyPlaybackState, SpotifyTrack } from "@/types/spotify";

const SPOTIFY_AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_API_BASE_URL = "https://api.spotify.com/v1";

// Playback control (play/pause/skip) + reading what's currently playing.
// Deliberately not requesting playlist-modify or library-modify scopes —
// this integration lets JARVIS control whatever's already playing on
// whichever of your devices has Spotify open (Spotify Connect handles
// routing to the active device), not manage your library or playlists.
const SPOTIFY_SCOPES = "user-read-playback-state user-modify-playback-state user-read-currently-playing";

const TOKEN_EXPIRY_SAFETY_MARGIN_MS = 60_000;

// Same "cap unbounded results" reasoning as GmailClient/GoogleCalendarClient.
const MAX_SEARCH_RESULTS_CAP = 10;

/**
 * Spotify access via raw fetch calls to Spotify's Accounts and Web API —
 * no SDK dependency, matching this project's existing style. Controls
 * playback on whatever device currently has Spotify open and active
 * (Spotify Connect's own device routing) rather than this codebase
 * needing any device-specific integration — the same account link works
 * whether Spotify is open on the Mac, the phone, or a speaker.
 *
 * REQUIRES REAL VALIDATION: never exercised against a real Spotify account.
 */
export class SpotifyClient {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
    private readonly tokenStore: SpotifyTokenStore
  ) {}

  /** The URL to send the user to for Spotify's consent screen. `state` is echoed back on the callback for CSRF protection. */
  buildAuthUrl(state: string): string {
    const url = new URL(SPOTIFY_AUTHORIZE_URL);
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", SPOTIFY_SCOPES);
    url.searchParams.set("state", state);
    return url.toString();
  }

  private basicAuthHeader(): string {
    return `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`;
  }

  /** Exchanges an OAuth authorization code for tokens and persists them. */
  async exchangeCodeForTokens(code: string): Promise<void> {
    const response = await fetch(SPOTIFY_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: this.basicAuthHeader(),
      },
      body: new URLSearchParams({
        code,
        redirect_uri: this.redirectUri,
        grant_type: "authorization_code",
      }).toString(),
    });

    if (!response.ok) {
      throw new Error(`Spotify OAuth code exchange failed (${response.status}): ${await response.text().catch(() => "")}`);
    }

    const data = (await response.json()) as { access_token: string; refresh_token?: string; expires_in: number };
    if (!data.refresh_token) {
      throw new Error(
        "Spotify didn't return a refresh token — revoke JARVIS's access at " +
          "https://www.spotify.com/account/apps/ and try linking again."
      );
    }

    this.tokenStore.save({
      refreshToken: data.refresh_token,
      accessToken: data.access_token,
      accessTokenExpiresAt: Date.now() + data.expires_in * 1000,
    });
  }

  private async refreshAccessToken(refreshToken: string): Promise<string> {
    const response = await fetch(SPOTIFY_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: this.basicAuthHeader(),
      },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }).toString(),
    });

    if (!response.ok) {
      throw new Error(`Spotify OAuth token refresh failed (${response.status}): ${await response.text().catch(() => "")}`);
    }

    const data = (await response.json()) as { access_token: string; expires_in: number };
    const expiresAt = Date.now() + data.expires_in * 1000;
    this.tokenStore.updateAccessToken(data.access_token, expiresAt);
    return data.access_token;
  }

  private async getValidAccessToken(): Promise<string> {
    const tokens = this.tokenStore.get();
    if (!tokens) {
      throw new Error("No Spotify account linked yet — visit GET /spotify/oauth/start to connect one.");
    }

    const stillValid =
      tokens.accessToken !== null &&
      tokens.accessTokenExpiresAt !== null &&
      tokens.accessTokenExpiresAt - TOKEN_EXPIRY_SAFETY_MARGIN_MS > Date.now();

    if (stillValid) return tokens.accessToken!;
    return this.refreshAccessToken(tokens.refreshToken);
  }

  private parseTrack(item: {
    name: string;
    artists: Array<{ name: string }>;
    album: { name: string };
    uri: string;
  }): SpotifyTrack {
    return {
      name: item.name,
      artists: item.artists.map((a) => a.name),
      album: item.album.name,
      uri: item.uri,
    };
  }

  /** What's currently playing (or paused), and on which device — null track/device when nothing is active. */
  async getPlaybackState(): Promise<SpotifyPlaybackState> {
    const accessToken = await this.getValidAccessToken();

    const response = await fetch(`${SPOTIFY_API_BASE_URL}/me/player`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    // 204 = no active device/session at all — a normal, common state, not an error.
    if (response.status === 204) {
      return { isPlaying: false, track: null, deviceName: null };
    }

    if (!response.ok) {
      throw new Error(`Spotify API request failed (${response.status}): ${await response.text().catch(() => "")}`);
    }

    const data = (await response.json()) as {
      is_playing: boolean;
      device?: { name: string };
      item?: { name: string; artists: Array<{ name: string }>; album: { name: string }; uri: string };
    };

    return {
      isPlaying: data.is_playing,
      track: data.item ? this.parseTrack(data.item) : null,
      deviceName: data.device?.name ?? null,
    };
  }

  /** Resumes playback on the currently active device, or starts playing a specific track URI if given. */
  async play(trackUri?: string): Promise<void> {
    const accessToken = await this.getValidAccessToken();

    const response = await fetch(`${SPOTIFY_API_BASE_URL}/me/player/play`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: trackUri ? JSON.stringify({ uris: [trackUri] }) : undefined,
    });

    if (!response.ok && response.status !== 204) {
      throw new Error(`Spotify play failed (${response.status}): ${await response.text().catch(() => "")}`);
    }
  }

  async pause(): Promise<void> {
    const accessToken = await this.getValidAccessToken();

    const response = await fetch(`${SPOTIFY_API_BASE_URL}/me/player/pause`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok && response.status !== 204) {
      throw new Error(`Spotify pause failed (${response.status}): ${await response.text().catch(() => "")}`);
    }
  }

  async skipToNext(): Promise<void> {
    const accessToken = await this.getValidAccessToken();

    const response = await fetch(`${SPOTIFY_API_BASE_URL}/me/player/next`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok && response.status !== 204) {
      throw new Error(`Spotify skip failed (${response.status}): ${await response.text().catch(() => "")}`);
    }
  }

  async skipToPrevious(): Promise<void> {
    const accessToken = await this.getValidAccessToken();

    const response = await fetch(`${SPOTIFY_API_BASE_URL}/me/player/previous`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok && response.status !== 204) {
      throw new Error(`Spotify skip failed (${response.status}): ${await response.text().catch(() => "")}`);
    }
  }

  /** Searches for tracks by free-text query — e.g. an artist/song name given in conversation. */
  async searchTracks(query: string, limit: number = 5): Promise<SpotifyTrack[]> {
    const accessToken = await this.getValidAccessToken();

    const url = new URL(`${SPOTIFY_API_BASE_URL}/search`);
    url.searchParams.set("q", query);
    url.searchParams.set("type", "track");
    url.searchParams.set("limit", String(Math.min(limit, MAX_SEARCH_RESULTS_CAP)));

    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      throw new Error(`Spotify search failed (${response.status}): ${await response.text().catch(() => "")}`);
    }

    const data = (await response.json()) as {
      tracks: { items: Array<{ name: string; artists: Array<{ name: string }>; album: { name: string }; uri: string }> };
    };

    return data.tracks.items.map((item) => this.parseTrack(item));
  }
}
