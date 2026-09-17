import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { MemoryStore } from "@/memory/MemoryStore";

export interface SearchMemoryInput extends Record<string, unknown> {
  query?: string;
}

/**
 * Lets Claude recall previously saved facts about the user. Read-only, so
 * always allowed — the risk is entirely in what gets *written* via
 * SAVE_MEMORY, not in reading it back.
 */
export function createSearchMemoryTool(memoryStore: MemoryStore): LocalTool<SearchMemoryInput> {
  return {
    id: "SEARCH_MEMORY",
    name: "search_memory",
    description:
      "Searches previously saved facts about the user by key fragment (e.g. \"user.\"). " +
      "Omit the query to list everything remembered so far. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Fragment to match against saved keys. Omit to list everything.",
        },
      },
    },
    requiredPermission: PermissionLevel.READ,
    target: "local",

    async execute(input) {
      const fragment = typeof input.query === "string" ? input.query : "";
      const results = memoryStore.search(fragment);
      return {
        success: true,
        data: results.map((r) => ({ key: r.key, value: r.value, savedAt: r.createdAt })),
      };
    },
  };
}
