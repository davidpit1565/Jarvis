import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { StudioClient } from "@/studio/StudioClient";

/**
 * Lets Claude answer "how's the Instagram account doing" / "how did that
 * reel do" — real followers/views/likes/comments/saves/shares, pulled
 * from the studio's own Instagram Graph API integration. READ: purely
 * informational, no side effects.
 */
export function createGetInstagramStatsTool(studioClient: StudioClient): LocalTool {
  return {
    id: "GET_INSTAGRAM_STATS",
    name: "get_instagram_stats",
    description:
      "Returns the Instagram account's real stats: follower count, and per-post views/reach/saves/shares/" +
      'likes/comments — for "how\'s the account doing" or "how did that reel do".',
    inputSchema: { type: "object", properties: {} },
    requiredPermission: PermissionLevel.READ,
    target: "local",

    async execute() {
      try {
        const stats = await studioClient.getInstagramStats();
        return { success: true, data: stats };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
