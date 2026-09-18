import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { RssNewsClient } from "@/news/RssNewsClient";

export interface GetNewsInput extends Record<string, unknown> {
  maxItems?: number;
}

/**
 * Lets Claude answer "what's in the news" / "anything new today" with
 * real headlines from the user's configured RSS feed. READ-only, free
 * (no API key), and limited to whatever one feed the user chose —
 * deliberately not a general web-wide news aggregator.
 */
export function createGetNewsTool(newsClient: RssNewsClient): LocalTool<GetNewsInput> {
  return {
    id: "GET_NEWS",
    name: "get_news",
    description:
      "Gets the latest headlines from the user's configured news RSS feed. Use this to answer questions like " +
      '"what\'s in the news" or "anything new today".',
    inputSchema: {
      type: "object",
      properties: {
        maxItems: { type: "number", description: "Maximum number of headlines to return. Defaults to 5." },
      },
    },
    requiredPermission: PermissionLevel.READ,
    target: "local",

    async execute(input) {
      const maxItems = typeof input.maxItems === "number" ? input.maxItems : undefined;
      if (maxItems !== undefined && (!Number.isInteger(maxItems) || maxItems <= 0)) {
        return { success: false, error: "maxItems must be a positive integer" };
      }

      try {
        const headlines = await newsClient.getTopHeadlines(maxItems);
        return { success: true, data: { headlines } };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
