import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { SpotifyClient } from "@/spotify/SpotifyClient";

export interface SkipTrackInput extends Record<string, unknown> {
  direction?: "next" | "previous";
}

/** Skips to the next or previous track on Spotify. SAFE_ACTION, same reasoning as PLAY_MUSIC. */
export function createSkipTrackTool(spotifyClient: SpotifyClient): LocalTool<SkipTrackInput> {
  return {
    id: "SKIP_TRACK",
    name: "skip_track",
    description: 'Skips to the "next" (default) or "previous" track on Spotify.',
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["next", "previous"], description: 'Defaults to "next".' },
      },
    },
    requiredPermission: PermissionLevel.SAFE_ACTION,
    target: "local",

    async execute(input) {
      if (input.direction !== undefined && input.direction !== "next" && input.direction !== "previous") {
        return { success: false, error: 'direction must be "next" or "previous" when provided' };
      }

      try {
        if (input.direction === "previous") {
          await spotifyClient.skipToPrevious();
        } else {
          await spotifyClient.skipToNext();
        }
        return { success: true, data: { direction: input.direction ?? "next" } };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
