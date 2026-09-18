import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { SpotifyClient } from "@/spotify/SpotifyClient";

/**
 * Lets Claude answer "what song is this" / "what's playing right now."
 * READ-level: purely informational, no side effects.
 */
export function createGetCurrentlyPlayingTool(spotifyClient: SpotifyClient): LocalTool {
  return {
    id: "GET_CURRENTLY_PLAYING",
    name: "get_currently_playing",
    description: "Returns what's currently playing (or paused) on Spotify, and which device it's playing on.",
    inputSchema: { type: "object", properties: {} },
    requiredPermission: PermissionLevel.READ,
    target: "local",

    async execute() {
      try {
        const state = await spotifyClient.getPlaybackState();
        return { success: true, data: state };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
