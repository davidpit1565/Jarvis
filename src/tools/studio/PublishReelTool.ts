import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { StudioClient } from "@/studio/StudioClient";

export interface PublishReelInput extends Record<string, unknown> {
  file: string;
  caption?: string;
}

/**
 * Publishes a rendered reel to Instagram (and, if that succeeds,
 * Facebook) — the exact same action the video studio's own "publish"
 * button triggers, from list_reels' `file`. DANGEROUS, like
 * UNLINK_CALENDAR/UNLINK_SPOTIFY, but for a strictly higher-stakes
 * reason: those undo a private account link, this creates a real,
 * irreversible public post. Always needs a fresh, per-call
 * confirmation — a standing grant here means "the user has opted in to
 * being asked," never "skip asking."
 */
export function createPublishReelTool(studioClient: StudioClient): LocalTool<PublishReelInput> {
  return {
    id: "PUBLISH_REEL",
    name: "publish_reel",
    description:
      'Publishes a reel to Instagram and Facebook — a real, public, irreversible post. Use the "file" name ' +
      'from a prior list_reels call. Pass "caption" to override the studio\'s own caption for that episode; ' +
      "omit it to use whatever the studio already has written.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: 'The reel\'s filename, from a prior list_reels call (e.g. "episode-14.mp4").' },
        caption: { type: "string", description: "Caption to post with it. Omit to use the studio's own caption." },
      },
      required: ["file"],
    },
    requiredPermission: PermissionLevel.DANGEROUS,
    target: "local",

    async execute(input) {
      if (typeof input.file !== "string" || input.file.trim() === "") {
        return { success: false, error: "file must be a non-empty string" };
      }
      if (input.caption !== undefined && typeof input.caption !== "string") {
        return { success: false, error: "caption must be a string when provided" };
      }

      try {
        const result = await studioClient.publish(input.file, input.caption ?? "");
        if (!result.ok) {
          return { success: false, error: result.reason ?? "Publish failed" };
        }
        return { success: true, data: result };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
