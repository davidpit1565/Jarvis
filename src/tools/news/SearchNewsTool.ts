import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { RssNewsClient } from "@/news/RssNewsClient";

export interface SearchNewsInput extends Record<string, unknown> {
  query: string;
  maxItems?: number;
}

/**
 * GET_NEWS only ever returns the top N headlines — this filters the same
 * configured RSS feed's headlines to ones whose title matches a keyword,
 * so "anything about the election" doesn't require Claude to scan the
 * unfiltered top-5 and hope it's in there. Same READ-only, single-feed
 * boundary as GET_NEWS.
 */
export function createSearchNewsTool(newsClient: RssNewsClient): LocalTool<SearchNewsInput> {
  return {
    id: "SEARCH_NEWS",
    name: "search_news",
    description:
      "Searches the user's configured news RSS feed for headlines whose title matches a keyword. Use this " +
      'for "anything about X in the news" — for just the latest headlines, use get_news instead.',
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keyword to search for in headline titles." },
        maxItems: { type: "number", description: "Maximum number of headlines to return. Defaults to 5." },
      },
      required: ["query"],
    },
    requiredPermission: PermissionLevel.READ,
    target: "local",

    async execute(input) {
      if (typeof input.query !== "string" || input.query.trim().length === 0) {
        return { success: false, error: "query must be a non-empty string" };
      }
      const maxItems = typeof input.maxItems === "number" ? input.maxItems : undefined;
      if (maxItems !== undefined && (!Number.isInteger(maxItems) || maxItems <= 0)) {
        return { success: false, error: "maxItems must be a positive integer" };
      }

      try {
        const headlines = await newsClient.searchHeadlines(input.query, maxItems);
        return { success: true, data: { headlines } };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
