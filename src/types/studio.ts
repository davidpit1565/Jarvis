export interface StudioReel {
  file: string;
  kind: "video" | "audio";
  episode: number | null;
  title: string | null;
  caption: string | null;
  builtAt: string;
  bytes: number;
  gatePassed: boolean | null;
}

export interface StudioInstagramMedia {
  id: string;
  caption: string;
  permalink: string | null;
  timestamp: string | null;
  mediaType: string | null;
  views: number | null;
  reach: number | null;
  saves: number | null;
  shares: number | null;
  likes: number | null;
  comments: number | null;
}

export type StudioInstagramStats =
  | { connected: false; reason: string }
  | {
      connected: true;
      username: string | null;
      followers: number | null;
      mediaCount: number | null;
      media: StudioInstagramMedia[];
    };

export interface StudioPublishResult {
  ok: boolean;
  reason?: string;
  reel?: { ok: boolean; reason?: string };
  facebook?: unknown;
  facebookPage?: unknown;
}
