import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { StudioClient } from "@/studio/StudioClient";

/**
 * Lets Claude answer "what reels are ready" / "tell me about the latest reel" —
 * reads the video studio's own rendered-reel list, the same data its
 * /renders page shows. READ: purely informational, no side effects.
 */
export function createListReelsTool(studioClient: StudioClient): LocalTool {
  return {
    id: "LIST_REELS",
    name: "list_reels",
    description:
      "Lists the reels rendered by the video studio, with their episode number, title, caption, and " +
      "whether they passed the quality gate — for questions like \"what reels are ready\" or \"tell me about the latest one\".",
    inputSchema: { type: "object", properties: {} },
    requiredPermission: PermissionLevel.READ,
    target: "local",

    async execute() {
      try {
        const reels = await studioClient.listReels();
        return { success: true, data: { reels } };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
