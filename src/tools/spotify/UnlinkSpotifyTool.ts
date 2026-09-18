import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { SpotifyTokenStore } from "@/spotify/SpotifyTokenStore";

/**
 * Lets the user disconnect their linked Spotify account. DANGEROUS (like
 * UNLINK_CALENDAR): disconnecting a real third-party account link always
 * needs a fresh confirmation, never a side effect of casual conversation.
 */
export function createUnlinkSpotifyTool(spotifyTokenStore: SpotifyTokenStore): LocalTool<Record<string, unknown>> {
  return {
    id: "UNLINK_SPOTIFY",
    name: "unlink_spotify",
    description:
      "Disconnects the linked Spotify account. After this, playback tools stop working until the user " +
      "re-links via GET /spotify/oauth/start. Use only when the user explicitly asks to disconnect/unlink Spotify.",
    inputSchema: { type: "object", properties: {} },
    requiredPermission: PermissionLevel.DANGEROUS,
    target: "local",

    async execute() {
      const wasLinked = spotifyTokenStore.isLinked();
      spotifyTokenStore.clear();
      return { success: true, data: { wasLinked } };
    },
  };
}
