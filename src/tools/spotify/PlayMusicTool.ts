import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { SpotifyClient } from "@/spotify/SpotifyClient";

export interface PlayMusicInput extends Record<string, unknown> {
  query?: string;
}

/**
 * Plays music on Spotify — either resumes whatever was paused (no
 * `query`), or searches for and plays the best-matching track ("play
 * Bohemian Rhapsody"). Controls whichever device currently has Spotify
 * open and active (Spotify Connect's own routing), not a specific
 * device — the same tool works whether Spotify is open on the Mac, the
 * phone, or a speaker. SAFE_ACTION and standing-granted: starting music
 * is a real, audible action but fully reversible (pause it) and
 * low-impact, the same reasoning as OPEN_APPLICATION.
 */
export function createPlayMusicTool(spotifyClient: SpotifyClient): LocalTool<PlayMusicInput> {
  return {
    id: "PLAY_MUSIC",
    name: "play_music",
    description:
      'Plays music on Spotify. Pass "query" (a song/artist name) to search for and play something specific ' +
      '("play Bohemian Rhapsody"); omit it to resume whatever was paused ("play the music").',
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Song/artist to search for and play. Omit to resume playback." },
      },
    },
    requiredPermission: PermissionLevel.SAFE_ACTION,
    target: "local",

    async execute(input) {
      if (input.query !== undefined && (typeof input.query !== "string" || input.query.trim() === "")) {
        return { success: false, error: "query must be a non-empty string when provided" };
      }

      try {
        if (!input.query) {
          await spotifyClient.play();
          return { success: true, data: { resumed: true } };
        }

        const results = await spotifyClient.searchTracks(input.query, 1);
        const track = results[0];
        if (!track) {
          return { success: false, error: `No track found matching "${input.query}"` };
        }

        await spotifyClient.play(track.uri);
        return { success: true, data: { track } };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
