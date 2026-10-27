/** David's own YouTube channel's basic info. */
export interface YouTubeChannel {
  id: string;
  title: string;
  subscriberCount: number;
  videoCount: number;
  account: string;
}

/** One of David's own uploaded videos, from his channel's uploads playlist. */
export interface YouTubeVideoSummary {
  id: string;
  title: string;
  publishedAt: string;
  url: string;
  account: string;
}

/** Views/likes/comments for one video, by id. */
export interface YouTubeVideoStats {
  id: string;
  title: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  account: string;
}
