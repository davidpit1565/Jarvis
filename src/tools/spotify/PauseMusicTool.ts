import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { SpotifyClient } from "@/spotify/SpotifyClient";

/** Pauses whatever's currently playing on Spotify. SAFE_ACTION, same reasoning as PLAY_MUSIC. */
export function createPauseMusicTool(spotifyClient: SpotifyClient): LocalTool {
  return {
    id: "PAUSE_MUSIC",
    name: "pause_music",
    description: "Pauses whatever's currently playing on Spotify.",
    inputSchema: { type: "object", properties: {} },
    requiredPermission: PermissionLevel.SAFE_ACTION,
    target: "local",

    async execute() {
      try {
        await spotifyClient.pause();
        return { success: true, data: { paused: true } };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
