import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { YouTubeClient } from "@/youtube/YouTubeClient";

export interface GetYouTubeVideoStatsInput extends Record<string, unknown> {
  videoId: string;
}

/**
 * Views/likes/comment count for one of David's YouTube videos, by its
 * video id (e.g. from LIST_MY_YOUTUBE_VIDEOS's own result). READ-only.
 */
export function createGetYouTubeVideoStatsTool(youtubeClient: YouTubeClient): LocalTool<GetYouTubeVideoStatsInput> {
  return {
    id: "GET_YOUTUBE_VIDEO_STATS",
    name: "get_youtube_video_stats",
    description: "Returns view/like/comment counts for one YouTube video, by its video id.",
    inputSchema: {
      type: "object",
      properties: {
        videoId: { type: "string", description: "The YouTube video id, e.g. from list_my_youtube_videos's result." },
      },
      required: ["videoId"],
    },
    requiredPermission: PermissionLevel.READ,
    target: "local",

    async execute(input) {
      if (typeof input.videoId !== "string" || input.videoId.trim() === "") {
        return { success: false, error: "videoId must be a non-empty string" };
      }

      try {
        const stats = await youtubeClient.getVideoStats(input.videoId);
        return { success: true, data: stats };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
