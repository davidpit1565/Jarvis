import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { YouTubeClient } from "@/youtube/YouTubeClient";

export interface ListMyYouTubeVideosInput extends Record<string, unknown> {
  maxResults?: number;
}

/**
 * David's own uploaded YouTube videos, newest first. READ-only.
 */
export function createListMyYouTubeVideosTool(youtubeClient: YouTubeClient): LocalTool<ListMyYouTubeVideosInput> {
  return {
    id: "LIST_MY_YOUTUBE_VIDEOS",
    name: "list_my_youtube_videos",
    description: "Lists the user's own uploaded YouTube videos, newest first.",
    inputSchema: {
      type: "object",
      properties: {
        maxResults: { type: "number", description: "Maximum number of videos to return. Defaults to 10." },
      },
    },
    requiredPermission: PermissionLevel.READ,
    target: "local",

    async execute(input) {
      const maxResults = typeof input.maxResults === "number" ? input.maxResults : undefined;
      if (maxResults !== undefined && (!Number.isInteger(maxResults) || maxResults <= 0)) {
        return { success: false, error: "maxResults must be a positive integer" };
      }

      try {
        const videos = await youtubeClient.listMyVideos(maxResults);
        return { success: true, data: { videos } };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
