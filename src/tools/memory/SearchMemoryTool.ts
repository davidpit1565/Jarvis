import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { MemoryStore } from "@/memory/MemoryStore";
import type { MemoryRecord } from "@/types/memory";

export interface SearchMemoryInput extends Record<string, unknown> {
  query?: string;
}

/** The minimal shape SEARCH_MEMORY needs from an embeddings client — matches OllamaEmbeddingsClient without importing it directly, so this tool has no hard dependency on Ollama specifically. */
export interface EmbeddingsClientLike {
  embed(text: string): Promise<number[]>;
}

/**
 * Lets Claude recall previously saved facts about the user. Read-only, so
 * always allowed — the risk is entirely in what gets *written* via
 * SAVE_MEMORY, not in reading it back.
 *
 * Semantic Memory Search (additive, opt-in): when `embeddingsClient` is
 * given (only true when OLLAMA_EMBEDDING_MODEL is configured — see
 * src/index.ts), a non-empty query is ALSO embedded and matched against
 * `MemoryStore.searchSemantic()`, so "find that thing about the dentist"
 * can surface a memory saved as "appointment with Dr. Cohen" even though
 * the two share no words. Exact-match (LIKE) results always come first,
 * semantic matches not already in that list are appended after — never the
 * other way around, so the plain-match behavior a user already relies on
 * is never reordered or hidden behind fuzzier results.
 *
 * When `embeddingsClient` is omitted (the default, and the only
 * possibility when embeddings aren't configured at all), this tool's
 * behavior is byte-for-byte identical to before this feature existed —
 * pure `MemoryStore.search()`, nothing else. If embeddings ARE configured
 * but Ollama happens to be unreachable for this one call, the semantic
 * step is skipped silently and the exact-match results are still returned
 * — a missing/flaky local embeddings server must never fail SEARCH_MEMORY
 * itself, which stays fully usable either way.
 */
export function createSearchMemoryTool(
  memoryStore: MemoryStore,
  embeddingsClient?: EmbeddingsClientLike
): LocalTool<SearchMemoryInput> {
  return {
    id: "SEARCH_MEMORY",
    name: "search_memory",
    description:
      "Searches previously saved facts about the user by a fragment matched against either the key " +
      '(e.g. "user.") or the value (e.g. "dog"). Omit the query to list everything remembered so far. Read-only.',
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Fragment to match against saved keys or values. Omit to list everything.",
        },
      },
    },
    requiredPermission: PermissionLevel.READ,
    target: "local",

    async execute(input) {
      const fragment = typeof input.query === "string" ? input.query : "";
      const exactResults = memoryStore.search(fragment);

      let results: MemoryRecord[] = exactResults;
      if (embeddingsClient && fragment.trim().length > 0) {
        try {
          const queryEmbedding = await embeddingsClient.embed(fragment);
          const semanticResults = memoryStore.searchSemantic(queryEmbedding);
          const seenIds = new Set(exactResults.map((r) => r.id));
          results = [...exactResults, ...semanticResults.filter((r) => !seenIds.has(r.id))];
        } catch {
          // Ollama unreachable/misconfigured for this one call — semantic
          // enhancement is optional, exact-match results are still a
          // complete, correct answer on their own.
        }
      }

      return {
        success: true,
        data: results.map((r) => ({ key: r.key, value: r.value, savedAt: r.createdAt })),
      };
    },
  };
}
