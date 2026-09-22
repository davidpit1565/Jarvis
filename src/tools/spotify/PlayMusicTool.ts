import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { SpotifyClient } from "@/spotify/SpotifyClient";

export interface PlayMusicInput extends Record<string, unknown> {
  query?: string;
  playlist?: string;
}

/**
 * Plays music on Spotify — resumes whatever was paused (no `query`/
 * `playlist`), searches for and plays the best-matching track ("play
 * Bohemian Rhapsody"), or starts one of the user's own playlists as a
 * queue by name ("play my workout playlist"). Controls whichever device
 * currently has Spotify open and active (Spotify Connect's own routing),
 * not a specific device — the same tool works whether Spotify is open on
 * the Mac, the phone, or a speaker. SAFE_ACTION and standing-granted:
 * starting music is a real, audible action but fully reversible (pause
 * it) and low-impact, the same reasoning as OPEN_APPLICATION.
 */
export function createPlayMusicTool(spotifyClient: SpotifyClient): LocalTool<PlayMusicInput> {
  return {
    id: "PLAY_MUSIC",
    name: "play_music",
    description:
      'Plays music on Spotify. Pass "query" (a song/artist name) to search for and play a specific track ' +
      '("play Bohemian Rhapsody"), or "playlist" (a playlist name) to start one of the user\'s own playlists ' +
      'as a queue ("play my workout playlist") — never both at once. Omit both to resume whatever was paused ' +
      '("play the music"). The result\'s "alternates" field (track search only) lists other close matches ' +
      "when the search was ambiguous — mention one if the played track doesn't look like a confident match.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Song/artist to search for and play. Omit to resume playback or play a playlist." },
        playlist: {
          type: "string",
          description: "Name of one of the user's own Spotify playlists to start playing. Omit to play a track or resume playback.",
        },
      },
    },
    requiredPermission: PermissionLevel.SAFE_ACTION,
    target: "local",

    async execute(input) {
      if (input.query !== undefined && (typeof input.query !== "string" || input.query.trim() === "")) {
        return { success: false, error: "query must be a non-empty string when provided" };
      }
      if (input.playlist !== undefined && (typeof input.playlist !== "string" || input.playlist.trim() === "")) {
        return { success: false, error: "playlist must be a non-empty string when provided" };
      }
      if (input.query && input.playlist) {
        return { success: false, error: "pass either query or playlist, not both" };
      }

      try {
        if (input.playlist) {
          const playlist = await spotifyClient.findPlaylistByName(input.playlist);
          if (!playlist) {
            return { success: false, error: `No playlist found matching "${input.playlist}"` };
          }
          await spotifyClient.playContext(playlist.uri);
          return { success: true, data: { playlist } };
        }

        if (!input.query) {
          await spotifyClient.play();
          return { success: true, data: { resumed: true } };
        }

        const results = await spotifyClient.searchTracks(input.query, 5);
        const track = results[0];
        if (!track) {
          return { success: false, error: `No track found matching "${input.query}"` };
        }

        await spotifyClient.play(track.uri);
        // Spotify search is often ambiguous (covers, same title by a
        // different artist) — playing the top match immediately keeps the
        // SAFE_ACTION "just play something reasonable" UX, but surfacing
        // the runner-up matches lets the model offer "did you mean X or Y
        // instead?" on the next turn rather than the user being stuck with
        // a wrong guess and no way to correct it.
        return { success: true, data: { track, alternates: results.slice(1) } };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
