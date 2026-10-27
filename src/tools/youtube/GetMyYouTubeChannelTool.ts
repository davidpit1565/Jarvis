import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { YouTubeClient } from "@/youtube/YouTubeClient";

export interface GetMyYouTubeChannelInput extends Record<string, unknown> {}

/**
 * Basic info about David's own YouTube channel: id, title, subscriber and
 * video counts. READ-only, no publish/upload capability at all.
 */
export function createGetMyYouTubeChannelTool(youtubeClient: YouTubeClient): LocalTool<GetMyYouTubeChannelInput> {
  return {
    id: "GET_MY_YOUTUBE_CHANNEL",
    name: "get_my_youtube_channel",
    description: "Returns basic info about the user's own YouTube channel: title, subscriber count, and video count.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    requiredPermission: PermissionLevel.READ,
    target: "local",

    async execute() {
      try {
        const channel = await youtubeClient.getMyChannel();
        return { success: true, data: channel };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
